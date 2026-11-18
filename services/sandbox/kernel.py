"""Persistent Python kernel. Run ONLY inside the gVisor sandbox image.

This process is intentionally not a Python security boundary. gVisor and the
container resource restrictions provide that boundary; its output is untrusted.
"""
from __future__ import annotations

import ast
import base64
import contextlib
import io
import json
import os
import queue
import stat
import sys
import threading
import traceback

# Python -I excludes the script directory. Restore only this root-owned kernel
# directory before importing the bundled protocol validator.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validation import MAX_IMAGE_BYTES, MAX_IMAGES, MAX_OUTPUT_BYTES, validate_path
from guest_model import GuestModelBroker

WORKSPACE = "/workspace/lesson"
WIRE_IN = None
WIRE_OUT = None
DEVNULL = None
WIRE_LOCK = threading.Lock()


def send(value: dict) -> None:
    data = memoryview(json.dumps(value, ensure_ascii=True, allow_nan=False).encode() + b"\n")
    with WIRE_LOCK:
        while data:
            written = WIRE_OUT.write(data)
            if not written:
                raise OSError("protocol output closed")
            data = data[written:]


class Capture:
    """Drain native/subprocess fd output too; discard excess without blocking."""
    def __init__(self):
        self.buffers = [bytearray(), bytearray()]
        self.truncated = [False, False]
        self.threads = []

    def drain(self, fd: int, index: int) -> None:
        try:
            while True:
                chunk = os.read(fd, 8192)
                if not chunk:
                    break
                remaining = MAX_OUTPUT_BYTES - len(self.buffers[index])
                self.buffers[index].extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    self.truncated[index] = True
        finally:
            os.close(fd)

    def __enter__(self):
        for index, target in enumerate((1, 2)):
            read_fd, write_fd = os.pipe()
            os.dup2(write_fd, target)
            os.close(write_fd)
            thread = threading.Thread(target=self.drain, args=(read_fd, index), daemon=True)
            thread.start()
            self.threads.append(thread)
        self.old_stdout, self.old_stderr = sys.stdout, sys.stderr
        # Recreate Python streams in case previous user code closed sys.stdout.
        self.stdout = io.TextIOWrapper(os.fdopen(os.dup(1), "wb", buffering=0), encoding="utf-8", write_through=True)
        self.stderr = io.TextIOWrapper(os.fdopen(os.dup(2), "wb", buffering=0), encoding="utf-8", write_through=True)
        sys.stdout, sys.stderr = self.stdout, self.stderr
        return self

    def __exit__(self, *unused):
        for stream in (self.stdout, self.stderr):
            with contextlib.suppress(Exception):
                stream.flush()
                stream.close()
        sys.stdout, sys.stderr = self.old_stdout, self.old_stderr
        os.dup2(DEVNULL, 1)
        os.dup2(DEVNULL, 2)
        # Background child processes retaining pipes must not pin the protocol.
        for thread in self.threads:
            thread.join(timeout=0.15)

    def text(self, index: int) -> str:
        value = bytes(self.buffers[index]).decode("utf-8", errors="replace")
        if self.truncated[index]:
            value += "\n[output truncated at 65536 bytes]"
        return value


def write_workspace_file(path: str, content: str) -> None:
    parts = validate_path(path).split("/")
    directory = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[:-1]:
            try:
                os.mkdir(component, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("workspace uploads must target a regular, unlinked file")
            os.ftruncate(fd, 0)
            with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as stream:
                stream.write(content)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def figures() -> list[dict]:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    for number in plt.get_fignums()[:MAX_IMAGES]:
        output = io.BytesIO()
        figure = plt.figure(number)
        figure.savefig(output, format="png", dpi=100)
        png = output.getvalue()
        if len(png) <= MAX_IMAGE_BYTES:
            images.append({"mimeType": "image/png", "data": base64.b64encode(png).decode("ascii")})
        else:
            print("[figure omitted: PNG exceeds 512 KiB]", file=sys.stderr)
    plt.close("all")
    return images


def execute(request: dict, namespace: dict) -> dict:
    result = {"status": "ok", "stdout": "", "stderr": "", "images": []}
    with Capture() as capture:
        try:
            os.chdir(WORKSPACE)
            for path, content in request.get("files", {}).items():
                write_workspace_file(path, content)
            # Ordinary imports and subprocesses use the persistent /workspace.
            import importlib
            importlib.invalidate_caches()
            filename = "<cell:" + request["cellId"] + ">"
            tree = ast.parse(request["code"], filename=filename, mode="exec")
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                tail = ast.Expression(tree.body.pop().value)
                exec(compile(tree, filename, "exec"), namespace)
                value = eval(compile(tail, filename, "eval"), namespace)
                if value is not None:
                    namespace["_"] = value
                    print(repr(value))
            else:
                exec(compile(tree, filename, "exec"), namespace)
            result["images"] = figures()
        except BaseException as error:
            result["status"] = "error"
            result["error"] = {"type": type(error).__name__, "message": str(error)[:2000]}
            traceback.print_exc()
    result["stdout"], result["stderr"] = capture.text(0), capture.text(1)
    return result


def main() -> None:
    global WIRE_IN, WIRE_OUT, DEVNULL
    WIRE_IN = os.fdopen(os.dup(0), "rb")
    WIRE_OUT = os.fdopen(os.dup(1), "wb", buffering=0)
    DEVNULL = os.open(os.devnull, os.O_RDWR)
    os.dup2(DEVNULL, 0)
    os.dup2(DEVNULL, 1)
    os.dup2(DEVNULL, 2)
    # Create the private directory as the learner, independently of tmpfs UID mapping.
    os.mkdir(WORKSPACE, mode=0o700)
    os.chdir(WORKSPACE)
    sys.path.insert(0, WORKSPACE)
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    commands = queue.Queue(maxsize=1)
    broker = GuestModelBroker(send)
    broker.start()
    def read_protocol():
        while True:
            try:
                line = WIRE_IN.readline(4_194_305)
                if not line or len(line) > 4_194_304 or not line.endswith(b"\n"):
                    os._exit(0)
                request = json.loads(line)
                if request.get("rpc") == "model_result":
                    broker.deliver(request)
                elif request.get("type") == "execute":
                    commands.put_nowait(request)
                else:
                    os._exit(1)
            except BaseException:
                os._exit(1)
    threading.Thread(target=read_protocol, daemon=True).start()
    send({"ready": True, "protocol": 1})
    while True:
        try:
            request = commands.get()
            send(execute(request, namespace))
        except BaseException:
            # Host treats any protocol failure as a lost session.
            break


if __name__ == "__main__":
    main()
