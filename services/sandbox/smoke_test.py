#!/usr/bin/env python3
"""Opt-in HTTP integration test; requires an operator-deployed real gateway.

SANDBOX_URL=https://sandbox.example.com SANDBOX_TOKEN=... python3 smoke_test.py
No code in this file executes directly on the host. All examples go over HTTP.
"""
import json
import os
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check_reader_isolation(call, first):
    """Exercise the same chapter for two readers and two chapters for one reader."""
    second = {**first, "sessionKey": "smoke_" + uuid.uuid4().hex}
    next_chapter = {**first, "chapterId": "chapter-two"}
    inspect_state = "from pathlib import Path\nprint(globals().get('reader_mark'), Path('note.txt').exists())"

    def run(scope, code, **extra):
        return call("execute", scope, code=code, cellId="check", **extra)

    def check_output(scope, code, output, count, **extra):
        result = run(scope, code, **extra)
        assert (result.get("status"), result.get("stdout"), result.get("executionCount")) == ("ok", output, count), result

    worker = None
    try:
        check_output(first, "reader_mark='first'\nprint(open('note.txt').read())", "alpha\n", 1,
                     files={"note.txt": "alpha"})
        check_output(second, inspect_state, "None False\n", 1)
        check_output(second, "reader_mark='second'\nprint(open('note.txt').read())", "beta\n", 2,
                     files={"note.txt": "beta"})
        check_output(first, "print(reader_mark, open('note.txt').read())", "first alpha\n", 2)
        result = {}
        def running():
            try:
                result.update(run(second, "import time\ntime.sleep(50)"))
            except Exception as error:
                result["exception"] = repr(error)
        worker = threading.Thread(target=running)
        worker.start()
        deadline = time.monotonic() + 5
        while call("status", second)["status"] != "busy":
            assert time.monotonic() < deadline, "second reader did not start"
            time.sleep(0.05)
        assert call("status", first)["status"] == "idle"
        interrupted = call("interrupt", second)
        worker.join(timeout=15)
        assert interrupted["sessionLost"] and result.get("status") == "interrupted", (interrupted, result)
        assert not call("status", second)["exists"]
        check_output(first, "print(reader_mark, open('note.txt').read())", "first alpha\n", 3)

        simultaneous_chapters = True
        try:
            check_output(next_chapter, inspect_state, "None False\n", 1)
        except urllib.error.HTTPError as error:
            if error.code != 429 or json.load(error).get("code") != "account_session_limit":
                raise
            # On a one-chapter-per-account profile, verify refusal and cold start
            # after capacity release instead of requiring an operator reconfigure it.
            simultaneous_chapters = False
            assert not call("status", next_chapter)["exists"]
            assert call("reset", first)["sessionLost"]
            check_output(next_chapter, inspect_state, "None False\n", 1)
        check_output(next_chapter, "reader_mark='other chapter'\nprint(open('note.txt').read())", "gamma\n", 2,
                     files={"note.txt": "gamma"})
        assert call("reset", first)["sessionLost"] == simultaneous_chapters
        check_output(next_chapter, "print(reader_mark, open('note.txt').read())", "other chapter gamma\n", 3)
        if not simultaneous_chapters:
            assert call("reset", next_chapter)["sessionLost"]
        check_output(first, inspect_state, "None False\n", 1)
    finally:
        for scope in (first, second, next_chapter):
            call("reset", scope)
        if worker is not None:
            worker.join(timeout=15)


def main():
    url = os.environ.get("SANDBOX_URL", "http://127.0.0.1:8090").rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}):
        raise ValueError("HTTPS is required except for a loopback deployment check")
    token_file = os.environ.get("SANDBOX_TOKEN_FILE")
    token = Path(token_file).read_text(encoding="utf-8").strip() if token_file else os.environ["SANDBOX_TOKEN"]
    identity = {"sessionKey": "smoke_" + uuid.uuid4().hex, "chapterId": "linux-check"}

    def call(action, scope=identity, **extra):
        request = urllib.request.Request(url + "/" + action,
            data=json.dumps({**scope, **extra}).encode(), method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=100) as reply:
            return json.load(reply)

    def execute(code, **extra):
        return call("execute", code=code, cellId="check_" + uuid.uuid4().hex[:12], **extra)

    try:
        check_reader_isolation(call, identity)
        print("PASS: account and chapter isolation for variables, files, outputs, interrupt and reset")
        assert call("status")["exists"] is False
        first = execute("value = 41\nopen('state.txt', 'w').write('saved')\nprint(value)")
        assert first["status"] == "ok" and first["executionCount"] == 1, first
        second = execute("print(value + 1)\nprint(open('state.txt').read())")
        assert second["status"] == "ok" and second["stdout"] == "42\nsaved\n", second
        assert second["executionCount"] == 2, second
        print("PASS: globals, files and execution counter persist")

        native = execute("import helper, subprocess, fcntl, os\n"
                         "print(helper.answer())\n"
                         "with open('lockfile', 'w') as f:\n    fcntl.flock(f, fcntl.LOCK_EX)\n"
                         "print(subprocess.check_output(['python', '-c', \"print('child-ok')\"], text=True).strip())\n"
                         "print(os.getuid(), os.path.exists('/var/run/docker.sock'), os.path.exists('/run/learner-engine/docker.sock'))",
                         files={"helper.py": "def answer():\n    return 'import-ok'\n"})
        assert native["status"] == "ok" and "import-ok\nchild-ok\n10001 False False" in native["stdout"], native
        print("PASS: multi-file import, subprocess, fcntl and non-root execution")

        plots = execute("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()")
        assert plots["status"] == "ok" and plots["images"][0]["mimeType"] == "image/png", plots
        print("PASS: PNG figure capture")

        capped = execute("import os\nos.write(1, b'x' * 200000)\nNone")
        assert capped["status"] == "ok" and len(capped["stdout"]) <= 65664 and "truncated" in capped["stdout"], capped
        print("PASS: native stdout is capped")

        timeout = execute("while True:\n    pass")
        assert timeout["status"] == "timeout" and timeout["sessionLost"] is True, timeout
        after = execute("print('value' in globals())")
        assert after["stdout"] == "False\n" and after["executionCount"] == 1, after
        print("PASS: time limit destroys variables/files and next execution starts fresh")

        result = {}
        def running_cell():
            try:
                result.update(execute("import time\ntime.sleep(50)"))
            except BaseException as error:
                result["failure"] = repr(error)
        thread = threading.Thread(target=running_cell)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if call("status")["status"] == "busy":
                break
            time.sleep(0.1)
        interrupted = call("interrupt")
        thread.join(timeout=15)
        assert interrupted["status"] == "interrupted" and interrupted["sessionLost"], interrupted
        assert result.get("status") == "interrupted" and result.get("sessionLost"), result
        assert not thread.is_alive()
        print("PASS: concurrent interrupt destroys the running session")
        if os.environ.get("SANDBOX_SMOKE_MODEL") == "1":
            status = call("status")
            assert status.get("modelConfigured"), "Model provider is not configured on the sandbox host"
            model_code = (
                "import json, os, urllib.request\n"
                "def model_call(stream=False):\n"
                "    payload = {'model': os.environ['LLM_MODEL'], 'messages': [{'role':'user','content':'Reply with one short greeting.'}], 'max_tokens':32, 'stream':stream}\n"
                "    req = urllib.request.Request(os.environ['LLM_BASE_URL'].rstrip('/')+'/chat/completions', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['LLM_API_KEY']})\n"
                "    with urllib.request.urlopen(req, timeout=50) as reply:\n        return reply.read().decode()\n"
            )
            normal = execute(model_code + "print(bool(json.loads(model_call())['choices']))")
            assert normal["status"] == "ok" and "True" in normal["stdout"], normal
            streaming = execute("print('data:' in model_call(True))")
            assert streaming["status"] == "ok" and "True" in streaming["stdout"], streaming
            child = execute("import subprocess\nprint(subprocess.check_output(['python', 'model_child.py'], text=True))",
                            files={"model_child.py": model_code + "print(bool(json.loads(model_call())['choices']))"})
            assert child["status"] == "ok" and "True" in child["stdout"], child
            print("PASS: real provider, buffered SSE and subprocess model requests")
        print("All real gateway checks passed.")
    finally:
        call("reset")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, ValueError, urllib.error.URLError) as error:
        print("Sandbox integration check failed:", error, file=sys.stderr)
        sys.exit(1)
