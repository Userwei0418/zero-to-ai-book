#!/usr/bin/env python3
"""Authenticated Linux sandbox gateway. Requires Docker + gVisor; no fallback."""
from __future__ import annotations

import base64
import contextlib
import json
import logging
import os
import queue
import shutil
import signal
import socket
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from validation import (
    MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_OUTPUT_BYTES, InvalidRequest,
    RateLimiter, authenticated, session_id, validate_payload,
)
from model_broker import ModelBroker, ModelConfig, broker_error

LOGGER = logging.getLogger("sandbox")
MAX_RESPONSE_BYTES = 4_194_304


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass
class Config:
    token: str = field(repr=False)
    bind: str = "127.0.0.1"
    port: int = 8090
    image: str = "ai-book-sandbox:1"
    docker: str = "docker"
    timeout_seconds: int = 15
    idle_seconds: int = 900
    max_sessions: int = 12
    max_sessions_per_account: int = 2
    max_executions: int = 4
    max_http_requests: int = 24
    deployment: str = "ai-book-lab"

    @classmethod
    def from_environment(cls) -> "Config":
        token_path = os.environ.get("SANDBOX_TOKEN_FILE")
        if token_path:
            with open(token_path, encoding="utf-8") as stream:
                token = stream.read(4096).strip()
        else:
            token = os.environ.get("SANDBOX_TOKEN", "")
        if len(token) < 32 or len(token) > 256 or any(c.isspace() for c in token):
            raise ValueError("SANDBOX_TOKEN must be a 32–256 character secret without whitespace")
        bind = os.environ.get("SANDBOX_BIND", "127.0.0.1")
        private_network = os.environ.get("SANDBOX_PRIVATE_NETWORK") == "1"
        if bind not in {"127.0.0.1", "::1"} and not (private_network and bind == "0.0.0.0"):
            raise ValueError("use loopback or opt in to a private container network")
        if private_network and os.environ.get("DOCKER_HOST") != "unix:///run/learner-engine/docker.sock":
            raise ValueError("private container network requires the dedicated learner-engine socket")
        deployment = os.environ.get("SANDBOX_DEPLOYMENT_ID", "ai-book-lab")
        validate_payload({"sessionKey": deployment, "chapterId": "check"}, "status")
        return cls(token=token, bind=bind,
                   port=env_int("SANDBOX_PORT", 8090, 1024, 65535),
                   image=os.environ.get("SANDBOX_IMAGE", "ai-book-sandbox:1"),
                   docker=shutil.which("docker") or "docker",
                   timeout_seconds=env_int("SANDBOX_TIMEOUT_SECONDS", 15, 1, 60),
                   idle_seconds=env_int("SANDBOX_IDLE_SECONDS", 900, 30, 3600),
                   max_sessions=env_int("SANDBOX_MAX_SESSIONS", 12, 1, 64),
                   max_sessions_per_account=env_int("SANDBOX_MAX_SESSIONS_PER_ACCOUNT", 2, 1, 64),
                   max_executions=env_int("SANDBOX_MAX_EXECUTIONS", 4, 1, 16),
                   max_http_requests=env_int("SANDBOX_MAX_HTTP_REQUESTS", 24, 4, 64),
                   deployment=deployment)


def response(status: str, *, count: int = 0, elapsed: int = 0,
             error: str | None = None, lost: bool = False, **extra) -> dict:
    result = {"status": status, "stdout": "", "stderr": "", "images": [],
              "executionCount": count, "elapsedMs": elapsed, "sessionLost": lost}
    if error:
        result["error"] = {"type": status, "message": error}
    result.update(extra)
    return result


def run_docker(config: Config, arguments: list[str], timeout: float = 15) -> subprocess.CompletedProcess:
    return subprocess.run([config.docker, *arguments], capture_output=True, text=True,
                          timeout=timeout, check=True, shell=False)


def check_runtime(config: Config) -> None:
    """Fail before accepting traffic if isolation or required cgroup limits lack support."""
    info = json.loads(run_docker(config, ["info", "--format", "{{json .}}"] ).stdout)
    if "runsc" not in info.get("Runtimes", {}):
        raise RuntimeError("Docker runtime 'runsc' is required; refusing to execute")
    for capability in ("MemoryLimit", "SwapLimit", "PidsLimit", "CpuCfsQuota", "CpuCfsPeriod"):
        if info.get(capability) is not True:
            raise RuntimeError(f"Docker must support {capability}; refusing to execute")
    run_docker(config, ["image", "inspect", config.image])


class SessionLost(RuntimeError):
    pass


class Session:
    def __init__(self, config: Config, identity: str, broker: ModelBroker | None = None, *, account: str = ""):
        self.config, self.identity = config, identity
        self.account = account
        self.broker = broker or ModelBroker()
        self.model_calls = 0
        self.write_lock = threading.Lock()
        self.name = "aibook-" + identity[:16] + "-" + uuid.uuid4().hex[:12]
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.messages: queue.Queue = queue.Queue(maxsize=2)
        self.process: subprocess.Popen | None = None
        self.creation_attempted = False
        self.removed = False
        self.cancelled = threading.Event()
        self.last_used = time.monotonic()
        self.execution_count = 0
        self.reason = "interrupted"

    def command(self) -> list[str]:
        return [self.config.docker, "create", "--rm", "--init", "--interactive", "--pull=never",
                "--name", self.name, "--runtime=runsc", "--network=none", "--read-only",
                "--user=10001:10001", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
                "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=64",
                "--ulimit=nofile=128:128", "--ulimit=nproc=64:64", "--ulimit=core=0", "--ipc=private", "--shm-size=16m",
                "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=64m,mode=1777",
                "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777", "--log-driver=none",
                "--hostname=python-lab", "--label=ai-book.sandbox.managed=true",
                "--label=ai-book.sandbox.deployment=" + self.config.deployment,
                "--env=HOME=/workspace/lesson", "--env=PYTHONDONTWRITEBYTECODE=1",
                "--env=PYTHONUNBUFFERED=1", "--env=MPLBACKEND=Agg",
                "--env=MPLCONFIGDIR=/tmp/matplotlib", "--env=OPENBLAS_NUM_THREADS=1",
                "--env=OMP_NUM_THREADS=1", "--env=LLM_BASE_URL=http://127.0.0.1:8765/v1",
                "--env=LLM_API_KEY=sandbox-broker", "--env=LLM_MODEL=" + self.broker.config.model,
                self.config.image]

    def _read_protocol(self) -> None:
        assert self.process and self.process.stdout
        try:
            while not self.cancelled.is_set():
                line = self.process.stdout.readline(MAX_RESPONSE_BYTES + 1)
                if not line or len(line) > MAX_RESPONSE_BYTES or not line.endswith(b"\n"):
                    raise SessionLost("kernel stopped or exceeded protocol output limit")
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise SessionLost("invalid kernel response")
                try:
                    self.messages.put_nowait(value)
                except queue.Full:
                    raise SessionLost("unexpected kernel protocol output")
        except (ValueError, RecursionError, OSError, SessionLost) as error:
            with contextlib.suppress(queue.Full):
                self.messages.put_nowait(SessionLost(str(error)[:256]))

    def _drain_stderr(self) -> None:
        assert self.process and self.process.stderr
        # Docker/guest diagnostics are untrusted and can contain submitted code.
        # Discard them; API returns bounded, generic service failures.
        with contextlib.suppress(OSError, ValueError):
            while self.process.stderr.read(8192):
                pass

    def start(self, timeout: float = 20) -> None:
        deadline = time.monotonic() + min(20, timeout)
        with self.lifecycle_lock:
            if self.cancelled.is_set():
                raise SessionLost("session was cancelled")
            # Complete named container creation before stop() can observe it.
            # An attach client racing with removal cannot create a new guest.
            self.creation_attempted = True
            run_docker(self.config, self.command()[1:], timeout=min(20, timeout))
            self.process = subprocess.Popen([self.config.docker, "start", "--attach", "--interactive", self.name], stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            shell=False, bufsize=65536)
            threading.Thread(target=self._read_protocol, daemon=True).start()
            threading.Thread(target=self._drain_stderr, daemon=True).start()
        ready = self.receive(deadline - time.monotonic())
        if ready != {"ready": True, "protocol": 1}:
            raise SessionLost("kernel startup protocol failed")

    def receive(self, timeout: float, allow_model: bool = False) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            if self.cancelled.is_set():
                raise SessionLost("session was cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("execution exceeded wall-clock limit")
            try:
                value = self.messages.get(timeout=min(remaining, 0.2))
            except queue.Empty:
                continue
            if isinstance(value, Exception):
                raise value
            if "rpc" in value:
                if not allow_model or value.get("rpc") != "model":
                    raise SessionLost("unexpected kernel RPC")
                self.model_calls += 1
                if self.model_calls > self.broker.config.calls_per_execution:
                    identifier = value.get("id", "")
                    if not isinstance(identifier, str) or len(identifier) != 32:
                        raise SessionLost("invalid model RPC identifier")
                    reply = broker_error(identifier, 429, "Model calls per execution exceeded the configured limit.")
                else:
                    reply = self.broker.request(value, self.identity, deadline, self.cancelled)
                self.write_protocol(reply, max(0.001, deadline - time.monotonic()))
                continue
            return value

    def write_protocol(self, wire: dict, timeout: float) -> None:
        assert self.process and self.process.stdin
        # A malicious previous cell can stop reading stdin. Enforce a write
        # deadline with a daemon thread; timeout always destroys the container.
        write_result: queue.Queue = queue.Queue(maxsize=1)
        def write() -> None:
            try:
                with self.write_lock:
                    data = json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
                    remaining = memoryview(data)
                    while remaining:
                        written = self.process.stdin.write(remaining)
                        if not written:
                            raise OSError("kernel pipe closed")
                        remaining = remaining[written:]
                    self.process.stdin.flush()
                write_result.put(None)
            except (OSError, ValueError) as error:
                write_result.put(error)
        threading.Thread(target=write, daemon=True).start()
        try:
            failure = write_result.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError("kernel input deadline exceeded") from error
        if failure:
            raise SessionLost("kernel input failed")

    def execute(self, payload: dict) -> dict:
        start = time.monotonic()
        if self.process is None:
            self.start(self.config.timeout_seconds)
        if self.cancelled.is_set():
            raise SessionLost("session was cancelled")
        remaining = self.config.timeout_seconds - (time.monotonic() - start)
        if remaining <= 0:
            raise TimeoutError("kernel startup exceeded the execution deadline")
        self.execution_count += 1
        self.model_calls = 0
        wire = {k: payload[k] for k in ("code", "files", "cellId")}
        wire["type"] = "execute"
        self.write_protocol(wire, remaining)
        value = self.receive(max(0, self.config.timeout_seconds - (time.monotonic() - start)), allow_model=True)
        if self.cancelled.is_set():
            raise SessionLost("session was cancelled")
        return sanitize_kernel_response(value)

    def stop(self, reason: str = "interrupted") -> None:
        with self.lifecycle_lock:
            if self.removed:
                return
            if not self.cancelled.is_set():
                self.reason = reason
                self.cancelled.set()
            if not self.creation_attempted:
                self.removed = True
                return
            # Names are generated internally, never interpolated into a shell.
            try:
                run_docker(self.config, ["rm", "--force", self.name], timeout=10)
                self.removed = True
            except subprocess.CalledProcessError:
                # An already-exited --rm container is also a successful cleanup.
                result = run_docker(self.config, ["ps", "--all", "--quiet", "--filter", "name=^/" + self.name + "$"])
                self.removed = not result.stdout.strip()
            finally:
                process = self.process
                if process:
                    if process.poll() is None:
                        process.kill()
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=3)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        with contextlib.suppress(Exception):
                            stream.close()
            if not self.removed:
                raise RuntimeError("container cleanup could not be confirmed")


def sanitize_kernel_response(value: dict) -> dict:
    """Never forward arbitrary guest JSON or trust guest resource/accounting claims."""
    if value.get("status") not in {"ok", "error"}:
        raise SessionLost("invalid kernel status")
    result = {"status": value["status"], "images": []}
    for field_name in ("stdout", "stderr"):
        text = value.get(field_name)
        if not isinstance(text, str):
            raise SessionLost("invalid kernel output")
        result[field_name] = text.encode("utf-8", errors="replace")[:MAX_OUTPUT_BYTES + 128].decode("utf-8", errors="replace")
    images = value.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise SessionLost("invalid image count")
    for image in images:
        if not isinstance(image, dict) or image.get("mimeType") != "image/png":
            raise SessionLost("invalid image metadata")
        encoded = image.get("data")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
            raise SessionLost("image quota exceeded")
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise SessionLost("invalid image encoding") from error
        if len(decoded) > MAX_IMAGE_BYTES or not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
            raise SessionLost("invalid PNG image")
        result["images"].append({"mimeType": "image/png", "data": encoded})
    error = value.get("error")
    if isinstance(error, dict):
        result["error"] = {"type": str(error.get("type", "ExecutionError"))[:100],
                           "message": str(error.get("message", "Execution failed"))[:2000]}
    return result


class Manager:
    def __init__(self, config: Config, broker: ModelBroker | None = None):
        self.config = config
        self.broker = broker or ModelBroker()
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()
        self.executions = threading.BoundedSemaphore(config.max_executions)
        self.available = True
        self.stopping = threading.Event()

    def cleanup_previous(self) -> None:
        ids = run_docker(self.config, ["ps", "--all", "--quiet", "--filter",
                         "label=ai-book.sandbox.managed=true", "--filter",
                         "label=ai-book.sandbox.deployment=" + self.config.deployment]).stdout.split()
        if ids:
            run_docker(self.config, ["rm", "--force", *ids], timeout=30)

    def discard(self, identity: str, session: Session, reason: str) -> None:
        # Keep the capacity reservation until removal has actually completed.
        try:
            session.stop(reason)
        except Exception:
            self.available = False
            LOGGER.error("Container cleanup failed; gateway is closed to new executions")
            raise
        with self.lock:
            if self.sessions.get(identity) is session:
                del self.sessions[identity]

    def execute(self, payload: dict) -> tuple[int, dict]:
        started = time.monotonic()
        if not self.available or self.stopping.is_set():
            return 503, response("unavailable", error="Sandbox service is unavailable")
        if not self.executions.acquire(blocking=False):
            return 429, response("busy", error="Global execution capacity is full")
        session = None
        acquired = False
        identity = session_id(payload)
        try:
            with self.lock:
                if not self.available or self.stopping.is_set():
                    return 503, response("unavailable", error="Sandbox service is unavailable")
                session = self.sessions.get(identity)
                if session is None:
                    if len(self.sessions) >= self.config.max_sessions:
                        return 429, response("busy", error="Sandbox session capacity is full")
                    account = payload["sessionKey"]
                    if sum(s.account == account for s in self.sessions.values()) >= self.config.max_sessions_per_account:
                        return 429, response("busy", error="Account chapter session capacity is full", code="account_session_limit")
                    session = Session(self.config, identity, self.broker, account=account)
                    self.sessions[identity] = session
                acquired = session.lock.acquire(blocking=False)
            if not acquired:
                return 409, response("busy", count=session.execution_count, error="This chapter is already executing")
            result = session.execute(payload)
            session.last_used = time.monotonic()
            return 200, response(result.pop("status"), count=session.execution_count,
                                 elapsed=int((time.monotonic() - started) * 1000), **result)
        except TimeoutError:
            assert session is not None
            self.discard(identity, session, "timeout")
            return 200, response("timeout", count=session.execution_count, lost=True,
                                 elapsed=int((time.monotonic() - started) * 1000),
                                 error="Time limit exceeded. Session variables and files were discarded.")
        except (OSError, ValueError, SessionLost, subprocess.SubprocessError):
            assert session is not None
            reason = session.reason if session.cancelled.is_set() else "unavailable"
            self.discard(identity, session, reason)
            return (200 if reason in {"interrupted", "reset"} else 503), response(
                "interrupted" if reason in {"interrupted", "reset"} else "unavailable",
                count=session.execution_count, lost=True,
                elapsed=int((time.monotonic() - started) * 1000),
                error="Session ended. Variables and files were discarded; run cells again.")
        finally:
            if acquired and session:
                session.lock.release()
            self.executions.release()

    def control(self, payload: dict, action: str) -> tuple[int, dict]:
        identity = session_id(payload)
        with self.lock:
            session = self.sessions.get(identity)
            if action == "status":
                if not self.available:
                    return 503, response("unavailable", error="Sandbox service is unavailable")
                if session is None:
                    return 200, response("idle", exists=False, runtime="gvisor", gpu=False,
                                         modelConfigured=self.broker.configured, modelStreaming="buffered")
                return 200, response("busy" if session.lock.locked() else "idle",
                                     count=session.execution_count, exists=True, runtime="gvisor", gpu=False,
                                     modelConfigured=self.broker.configured, modelStreaming="buffered")
        if session:
            self.discard(identity, session, "reset" if action == "reset" else "interrupted")
        return 200, response("idle" if action == "reset" else "interrupted", lost=bool(session), exists=False)

    def reap(self) -> None:
        while not self.stopping.wait(10):
            now = time.monotonic()
            with self.lock:
                expired = [(key, s) for key, s in self.sessions.items()
                           if now - s.last_used > self.config.idle_seconds and s.lock.acquire(blocking=False)]
            for identity, session in expired:
                try:
                    self.discard(identity, session, "idle")
                except Exception:
                    pass
                finally:
                    session.lock.release()

    def close(self) -> None:
        self.stopping.set()
        with self.lock:
            sessions = list(self.sessions.items())
        for identity, session in sessions:
            with contextlib.suppress(Exception):
                self.discard(identity, session, "shutdown")


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, config: Config, manager: Manager):
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        self.config, self.manager = config, manager
        self.rate = RateLimiter(maximum=60)
        self.global_rate = RateLimiter(maximum=600, max_keys=1)
        self.request_slots = threading.BoundedSemaphore(config.max_http_requests)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            with contextlib.suppress(OSError):
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class Handler(BaseHTTPRequestHandler):
    server: GatewayServer
    server_version = "SandboxGateway/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)
        # A socket idle timeout alone can be defeated by trickling bytes.
        # Limit the entire header/body intake phase, then cancel before execution.
        self.intake_deadline = threading.Timer(10, self.expire_intake)
        self.intake_deadline.daemon = True
        self.intake_deadline.start()

    def expire_intake(self):
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)

    def finish(self):
        self.intake_deadline.cancel()
        super().finish()

    def log_message(self, format, *args):
        # Do not log bearer tokens, code, paths or user identifiers.
        pass

    def reply(self, status: int, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(encoded)

    def do_GET(self):
        self.reply(405, response("error", error="Use POST"))

    def do_OPTIONS(self):
        # Deliberately no CORS headers: only the website's server calls this API.
        self.reply(405, response("error", error="Browser access is not supported"))

    def do_POST(self):
        try:
            self.handle_post()
        except (TimeoutError, socket.timeout):
            self.reply(408, response("error", error="Request body deadline exceeded"))
        except Exception:
            LOGGER.error("Gateway request failed; response details withheld")
            self.reply(503, response("unavailable", lost=True, error="Sandbox service is unavailable"))

    def handle_post(self):
        authorizations = self.headers.get_all("Authorization", [])
        if len(authorizations) != 1 or not authenticated(authorizations[0], self.server.config.token):
            self.reply(401, response("error", error="Unauthorized"))
            return
        actions = {"/execute": "execute", "/reset": "reset", "/interrupt": "interrupt", "/status": "status"}
        action = actions.get(self.path)
        if action is None:
            self.reply(404, response("error", error="Unknown endpoint"))
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
            self.reply(400, response("error", error="One Content-Length header is required; chunked bodies are rejected"))
            return
        try:
            length = int(lengths[0])
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self.reply(413, response("error", error=f"Request body must be at most {MAX_BODY_BYTES} bytes"))
            return
        if self.headers.get_content_type() != "application/json":
            self.reply(415, response("error", error="Content-Type must be application/json"))
            return
        if not self.server.global_rate.allow("gateway"):
            self.reply(429, response("busy", error="Gateway request rate exceeded"))
            return
        raw = self.rfile.read(length)
        self.intake_deadline.cancel()
        if len(raw) != length:
            self.reply(400, response("error", error="Incomplete request body"))
            return
        try:
            payload = validate_payload(json.loads(raw), action)
        except (ValueError, UnicodeError, RecursionError) as error:
            self.reply(400, response("error", error=str(error)[:256]))
            return
        # Reserve a separate allowance for interrupt/reset so execution polling
        # cannot consume all control requests for a session.
        bucket = session_id(payload) + (":control" if action in {"reset", "interrupt"} else ":work")
        if not self.server.rate.allow(bucket):
            self.reply(429, response("busy", error="Session request rate exceeded"))
            return
        try:
            status, result = (self.server.manager.execute(payload) if action == "execute"
                              else self.server.manager.control(payload, action))
        except (OSError, RuntimeError, subprocess.SubprocessError):
            status, result = 503, response("unavailable", error="Sandbox service is unavailable")
        self.reply(status, result)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = Config.from_environment()
    check_runtime(config)
    manager = Manager(config, ModelBroker(ModelConfig.from_environment()))
    manager.cleanup_previous()
    server = GatewayServer((config.bind, config.port), config, manager)
    threading.Thread(target=manager.reap, daemon=True).start()
    def stop(signum, frame):
        manager.stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    LOGGER.info("Sandbox gateway listening on %s:%d; gVisor required", config.bind, config.port)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        manager.close()


if __name__ == "__main__":
    main()
