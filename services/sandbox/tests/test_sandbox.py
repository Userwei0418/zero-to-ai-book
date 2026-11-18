"""No Docker daemon or untrusted-code execution is used by these unit tests."""
import base64
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gateway
import kernel
from validation import (InvalidRequest, MAX_BODY_BYTES, MAX_FILE_BYTES, MAX_FILES_BYTES, MAX_FILES, RateLimiter, authenticated,
                        session_id, validate_path, validate_payload)

TOKEN = "test-only-secret-" + "a" * 48
IDENTITY = {"sessionKey": "user_42", "chapterId": "linux-01"}
EXECUTE = {**IDENTITY, "code": "print('hello')", "cellId": "cell-1"}


class ValidationTests(unittest.TestCase):
    def test_auth_requires_exact_bearer_token(self):
        self.assertTrue(authenticated("Bearer " + TOKEN, TOKEN))
        for value in [None, "", TOKEN, "bearer " + TOKEN, "Bearer " + TOKEN + "x", "Bearer 中文"]:
            self.assertFalse(authenticated(value, TOKEN))

    def test_auth_uses_constant_time_primitive(self):
        with patch("validation.secrets.compare_digest", return_value=True) as compare:
            self.assertTrue(authenticated("Bearer token", "secret"))
            compare.assert_called_once_with(b"Bearer token", b"Bearer secret")

    def test_safe_paths(self):
        for value in ["module.py", "helpers/math_ops.py", "data/run-01.csv"]:
            self.assertEqual(validate_path(value), value)

    def test_paths_reject_traversal_and_ambiguous_encodings(self):
        for value in ["../x", "/etc/passwd", "a/../x", "./x", "a//x", "a/", "a\\x",
                      "C:/x", "a\x00.py", ".secret", "%2e%2e/x", "a;$HOME", "a/./x", ""]:
            with self.subTest(value=value), self.assertRaises(InvalidRequest):
                validate_path(value)

    def test_payload_normalizes_both_file_formats(self):
        mapping = validate_payload({**EXECUTE, "files": {"a.py": "x=1"}}, "execute")
        listing = validate_payload({**EXECUTE, "files": [{"path": "a.py", "content": "x=1"}]}, "execute")
        self.assertEqual(mapping, listing)

    def test_payload_rejects_bad_ids_and_unknown_fields(self):
        for extra in [{"sessionKey": "$(id)"}, {"chapterId": "../a"}, {"cellId": None}, {"image": "host"}]:
            with self.subTest(extra=extra), self.assertRaises(InvalidRequest):
                validate_payload({**EXECUTE, **extra}, "execute")

    def test_utf8_code_limit_counts_bytes(self):
        with self.assertRaises(InvalidRequest):
            validate_payload({**EXECUTE, "code": "汉" * 21846}, "execute")

    def test_file_limits_and_duplicate_paths(self):
        invalid = [{str(i) + ".py": "" for i in range(MAX_FILES + 1)}, {"a.py": "x" * (MAX_FILE_BYTES + 1)},
                   {"a.py": "x" * MAX_FILE_BYTES, "b.py": "y" * (MAX_FILES_BYTES - MAX_FILE_BYTES + 1)},
                   [{"path": "a.py", "content": "1"}, {"path": "a.py", "content": "2"}],
                   [{"path": "a.py", "content": "1", "mode": "0777"}]]
        for files in invalid:
            with self.subTest(kind=type(files)), self.assertRaises(InvalidRequest):
                validate_payload({**EXECUTE, "files": files}, "execute")

    def test_published_experiment_bundles_fit_request_and_guest_limits(self):
        chapters = Path(__file__).resolve().parents[3] / "public/course/chapters"
        checked = set()
        for path in chapters.glob("*.json"):
            chapter = json.loads(path.read_text(encoding="utf-8"))
            for block in chapter["blocks"]:
                if block.get("type") != "code" or not block.get("runnable"):
                    continue
                with self.subTest(chapter=chapter["id"], cell=block["id"]):
                    payload = {"sessionKey": "a" * 64, "chapterId": chapter["id"],
                               "cellId": block["id"], "code": block["code"], "files": chapter["files"]}
                    self.assertEqual(validate_payload(payload, "execute"), payload)
                    wire = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    self.assertLessEqual(len(wire), MAX_BODY_BYTES)
                    checked.add(chapter["id"])
        self.assertTrue({"upper-14", "lower-03"}.issubset(checked))

    def test_session_keys_are_isolated_by_user_and_chapter(self):
        identities = [IDENTITY, {**IDENTITY, "sessionKey": "user_43"}, {**IDENTITY, "chapterId": "linux-02"},
                      {"sessionKey": "ab", "chapterId": "c"}, {"sessionKey": "a", "chapterId": "bc"}]
        self.assertEqual(len({session_id(p) for p in identities}), len(identities))

    def test_rate_limit_and_expiry(self):
        limiter = RateLimiter(maximum=2, window=10, max_keys=1)
        self.assertTrue(limiter.allow("a", now=0))
        self.assertTrue(limiter.allow("a", now=1))
        self.assertFalse(limiter.allow("a", now=2))
        self.assertFalse(limiter.allow("b", now=2))
        self.assertTrue(limiter.allow("a", now=10))
        self.assertTrue(limiter.allow("b", now=21))


class WorkspaceWriteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.patch = patch.object(kernel, "WORKSPACE", self.directory.name)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    def test_nested_upload_and_overwrite(self):
        kernel.write_workspace_file("package/mod.py", "value = 42\n")
        path = Path(self.directory.name) / "package/mod.py"
        self.assertEqual(path.read_text(), "value = 42\n")
        kernel.write_workspace_file("package/mod.py", "x=1")
        self.assertEqual(path.read_text(), "x=1")

    def test_symlink_file_and_parent_are_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "secret"
            target.write_text("unchanged")
            (Path(self.directory.name) / "link").symlink_to(target)
            (Path(self.directory.name) / "dir").symlink_to(outside, target_is_directory=True)
            for path in ["link", "dir/secret"]:
                with self.assertRaises(OSError):
                    kernel.write_workspace_file(path, "modified")
            self.assertEqual(target.read_text(), "unchanged")

    def test_hardlink_rejected_before_truncation(self):
        target = Path(self.directory.name) / "original"
        target.write_text("unchanged")
        os.link(target, Path(self.directory.name) / "linked")
        with self.assertRaises(ValueError):
            kernel.write_workspace_file("linked", "modified")
        self.assertEqual(target.read_text(), "unchanged")

    def test_fifo_rejected_without_blocking(self):
        os.mkfifo(Path(self.directory.name) / "fifo")
        with self.assertRaises((OSError, ValueError)):
            kernel.write_workspace_file("fifo", "blocked")


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.config = gateway.Config(token=TOKEN)

    def test_runtime_missing_is_fail_closed(self):
        with patch("gateway.run_docker", return_value=SimpleNamespace(stdout='{"Runtimes":{"runc":{}}}')) as docker:
            with self.assertRaisesRegex(RuntimeError, "runsc"):
                gateway.check_runtime(self.config)
            self.assertEqual(docker.call_count, 1)

    def test_cgroup_support_is_mandatory(self):
        data = {"Runtimes": {"runsc": {}}, "MemoryLimit": True}
        with patch("gateway.run_docker", return_value=SimpleNamespace(stdout=json.dumps(data))):
            with self.assertRaisesRegex(RuntimeError, "SwapLimit"):
                gateway.check_runtime(self.config)

    def test_valid_runtime_and_local_image_are_checked(self):
        data = {"Runtimes": {"runsc": {}}, **dict.fromkeys(
            ["MemoryLimit", "SwapLimit", "PidsLimit", "CpuCfsQuota", "CpuCfsPeriod"], True)}
        with patch("gateway.run_docker", side_effect=[SimpleNamespace(stdout=json.dumps(data)), SimpleNamespace(stdout="[]")]) as docker:
            gateway.check_runtime(self.config)
            self.assertEqual(docker.call_args.args[1], ["image", "inspect", self.config.image])

    def test_container_command_enforces_boundary(self):
        command = gateway.Session(self.config, session_id(IDENTITY)).command()
        for flag in ["--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL",
                     "--security-opt=no-new-privileges:true", "--user=10001:10001", "--memory=256m",
                     "--memory-swap=256m", "--cpus=1", "--pids-limit=64", "--pull=never", "--log-driver=none"]:
            self.assertIn(flag, command)
        self.assertFalse(any("docker.sock" in part or part.startswith("--privileged") or part == "--volume" for part in command))
        self.assertNotIn(TOKEN, " ".join(command))

    def test_config_rejects_public_bind_and_placeholder_secret(self):
        with patch.dict(os.environ, {"SANDBOX_TOKEN": "CHANGE_ME"}, clear=True):
            with self.assertRaises(ValueError):
                gateway.Config.from_environment()
        with patch.dict(os.environ, {"SANDBOX_TOKEN": TOKEN, "SANDBOX_BIND": "0.0.0.0"}, clear=True):
            with self.assertRaisesRegex(ValueError, "loopback"):
                gateway.Config.from_environment()

    def test_container_bind_requires_dedicated_socket_and_explicit_private_mode(self):
        env = {"SANDBOX_TOKEN": TOKEN, "SANDBOX_BIND": "0.0.0.0", "SANDBOX_PRIVATE_NETWORK": "1"}
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(ValueError, "learner-engine"):
                gateway.Config.from_environment()
            os.environ["DOCKER_HOST"] = "unix:///run/learner-engine/docker.sock"
            self.assertEqual(gateway.Config.from_environment().bind, "0.0.0.0")

    def test_failed_attach_removes_created_guest_only_once(self):
        session = gateway.Session(self.config, session_id(IDENTITY))
        with patch("gateway.run_docker") as docker, patch("gateway.subprocess.Popen", side_effect=OSError) as attach:
            with self.assertRaises(OSError):
                session.start()
            session.stop("reset")
            session.stop("interrupted")
        self.assertEqual(docker.call_args_list[0].args[1][0], "create")
        self.assertEqual(attach.call_args.args[0], [self.config.docker, "start", "--attach", "--interactive", session.name])
        self.assertEqual(docker.call_count, 2)
        self.assertEqual(docker.call_args.args[1], ["rm", "--force", session.name])
        self.assertEqual(session.reason, "reset")

    def test_guest_accounting_and_extra_keys_are_not_trusted(self):
        value = gateway.sanitize_kernel_response({"status": "ok", "stdout": "hi", "stderr": "", "images": [],
                                                   "executionCount": -900, "secret": "guest-chosen"})
        self.assertNotIn("secret", value)
        self.assertNotIn("executionCount", value)

    def test_guest_output_is_capped(self):
        value = gateway.sanitize_kernel_response({"status": "ok", "stdout": "x" * 200000, "stderr": ""})
        self.assertLessEqual(len(value["stdout"]), 65536 + 128)

    def test_invalid_guest_images_are_rejected(self):
        for image in [{"mimeType": "text/html", "data": "evil"}, {"mimeType": "image/png", "data": "%%%"},
                      {"mimeType": "image/png", "data": base64.b64encode(b"not png").decode()}]:
            with self.assertRaises(gateway.SessionLost):
                gateway.sanitize_kernel_response({"status": "ok", "stdout": "", "stderr": "", "images": [image]})


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.manager = gateway.Manager(gateway.Config(token=TOKEN, max_executions=1))

    def test_global_concurrency_rejects_without_creating_session(self):
        self.manager.executions.acquire()
        status, result = self.manager.execute(validate_payload(EXECUTE, "execute"))
        self.assertEqual((status, result["status"]), (429, "busy"))
        self.assertEqual(self.manager.sessions, {})

    def test_same_session_concurrency_rejected(self):
        session = gateway.Session(self.manager.config, session_id(IDENTITY))
        session.lock.acquire()
        self.manager.sessions[session.identity] = session
        status, result = self.manager.execute(validate_payload(EXECUTE, "execute"))
        self.assertEqual((status, result["status"]), (409, "busy"))
        session.lock.release()

    def test_timeout_destroys_state_and_releases_capacity(self):
        session = gateway.Session(self.manager.config, session_id(IDENTITY))
        session.execution_count = 2
        session.execute = Mock(side_effect=TimeoutError())
        session.stop = Mock()
        self.manager.sessions[session.identity] = session
        status, result = self.manager.execute(validate_payload(EXECUTE, "execute"))
        self.assertEqual((status, result["status"], result["sessionLost"]), (200, "timeout", True))
        session.stop.assert_called_once_with("timeout")
        self.assertEqual(self.manager.sessions, {})
        self.assertTrue(self.manager.executions.acquire(blocking=False))
        self.assertFalse(session.lock.locked())

    def test_unconfirmed_cleanup_blocks_future_execution(self):
        session = gateway.Session(self.manager.config, session_id(IDENTITY))
        session.stop = Mock(side_effect=RuntimeError("daemon unavailable"))
        self.manager.sessions[session.identity] = session
        with self.assertRaises(RuntimeError):
            self.manager.discard(session.identity, session, "timeout")
        self.assertFalse(self.manager.available)
        self.assertEqual(self.manager.execute(validate_payload(EXECUTE, "execute"))[0], 503)

    def test_two_readers_and_two_chapters_have_independent_state_and_control(self):
        first = IDENTITY
        second = {**first, "sessionKey": "user_43"}
        next_chapter = {**first, "chapterId": "linux-02"}
        manager = gateway.Manager(gateway.Config(token=TOKEN, max_executions=2, max_sessions=3))

        def mock_kernel(session, payload):
            session.execution_count += 1
            if payload["code"] == "write":
                session.test_file = payload["files"]["shared.txt"]
            return {"status": "ok", "stdout": getattr(session, "test_file", "")}

        def run(scope, value=None):
            code = "read" if value is None else "write"
            files = {} if value is None else {"shared.txt": value}
            return manager.execute({**scope, "cellId": "same-cell", "code": code, "files": files})

        with patch.object(gateway.Session, "execute", autospec=True, side_effect=mock_kernel):
            for scope, value in [(first, "one"), (second, "two"), (next_chapter, "three")]:
                status, clean = run(scope)
                self.assertEqual((status, clean["stdout"], clean["executionCount"]), (200, "", 1))
                self.assertEqual(run(scope, value)[1]["stdout"], value)
            names = {session.name for session in manager.sessions.values()}
            self.assertEqual(len(names), 3)
            old = manager.sessions[session_id(first)]
            manager.control(first, "reset")
            self.assertTrue(old.cancelled.is_set())
            self.assertEqual(run(first)[1]["stdout"], "")
            replacement = manager.sessions[session_id(first)]
            # An old execute handler may finish cleanup after reset and restart.
            manager.discard(session_id(first), old, "interrupted")
            self.assertIs(manager.sessions[session_id(first)], replacement)
            self.assertEqual(run(second)[1]["stdout"], "two")
            manager.control(second, "interrupt")
            self.assertFalse(manager.control(second, "status")[1]["exists"])
            self.assertEqual(run(next_chapter)[1]["stdout"], "three")
            self.assertTrue(manager.control(first, "status")[1]["exists"])

    def test_per_account_limit_reserves_capacity_for_another_reader(self):
        manager = gateway.Manager(gateway.Config(token=TOKEN, max_sessions=3, max_sessions_per_account=2))
        def run(account, chapter):
            return manager.execute({**EXECUTE, "sessionKey": account, "chapterId": chapter})[0]
        with patch.object(gateway.Session, "execute", side_effect=lambda payload: {"status": "ok"}):
            self.assertEqual(run("readerA", "first"), 200)
            self.assertEqual(run("readerA", "second"), 200)
            self.assertEqual(run("readerA", "third"), 429)
            self.assertEqual(run("readerB", "first"), 200)
            manager.control({"sessionKey": "readerA", "chapterId": "first"}, "reset")
            self.assertEqual(run("readerA", "third"), 200)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.manager = Mock()
        self.manager.execute.return_value = (200, gateway.response("ok", stdout="hello\n"))
        self.manager.control.return_value = (200, gateway.response("idle"))
        self.server = gateway.GatewayServer(("127.0.0.1", 0), gateway.Config(token=TOKEN), self.manager)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, path="/execute", body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        data = json.dumps(EXECUTE if body is None else body)
        actual_headers = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
        if headers:
            actual_headers.update(headers)
        connection.request("POST", path, body=data, headers=actual_headers)
        response = connection.getresponse()
        status, content, response_headers = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, json.loads(content), response_headers

    def test_authorized_execution(self):
        status, content, headers = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(content["stdout"], "hello\n")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.manager.execute.assert_called_once()

    def test_unauthorized_never_reaches_manager(self):
        self.assertEqual(self.post(headers={"Authorization": "Bearer wrong"})[0], 401)
        self.manager.execute.assert_not_called()

    def test_body_limit_rejects_before_read(self):
        self.assertEqual(self.post(headers={"Content-Length": str(MAX_BODY_BYTES + 1)})[0], 413)
        self.manager.execute.assert_not_called()

    def test_content_type_and_transfer_encoding_rejected(self):
        self.assertEqual(self.post(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.post(headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_invalid_file_path_rejected_over_http(self):
        self.assertEqual(self.post(body={**EXECUTE, "files": {"../escape": "x"}})[0], 400)
        self.manager.execute.assert_not_called()

    def test_unknown_endpoint_rejected(self):
        self.assertEqual(self.post(path="/execute?admin=true")[0], 404)

    def test_control_has_reserved_rate_bucket(self):
        self.server.rate = RateLimiter(maximum=1)
        self.assertEqual(self.post(path="/status", body=IDENTITY)[0], 200)
        self.assertEqual(self.post(path="/status", body=IDENTITY)[0], 429)
        self.assertEqual(self.post(path="/interrupt", body=IDENTITY)[0], 200)


if __name__ == "__main__":
    unittest.main()
