import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gateway
from guest_model import GuestModelBroker
from model_broker import MAX_MODEL_RESPONSE, ModelBroker, ModelConfig, validate_model_request

SECRET = "host-secret-must-never-reach-guest"
CONFIG = ModelConfig(key=SECRET, base_url="https://provider.example/v1", model="test-model")


def envelope(**body):
    return {"rpc": "model", "id": "a" * 32, "method": "POST", "path": "/v1/chat/completions",
            "body": {"model": "test-model", "messages": [{"role": "user", "content": "hello"}], **body}}


class FakeResponse:
    def __init__(self, body=b'{"choices":[{"message":{"content":"real fixture"}}]}', status=200, content_type="application/json"):
        self.body = io.BytesIO(body)
        self.status = status
        self.content_type = content_type

    def getheader(self, name, default):
        return self.content_type

    def read1(self, size):
        return self.body.read(size)


class ModelValidationTests(unittest.TestCase):
    def test_default_completion_budget(self):
        _, encoded = validate_model_request(envelope(), CONFIG)
        self.assertEqual(json.loads(encoded)["max_tokens"], 1024)

    def test_cannot_choose_provider_path_or_url(self):
        for change in [{"path": "https://internal.example/admin"}, {"path": "/v1/embeddings"},
                       {"method": "GET"}, {"url": "https://evil.example"}, {"rpc": "shell"}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_model_request({**envelope(), **change}, CONFIG)

    def test_model_and_token_budget_locked(self):
        for body in [{"model": "expensive-model"}, {"max_tokens": 2049}, {"max_tokens": True},
                     {"n": 3}, {"stream": "yes"}, {"max_completion_tokens": -1}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_model_request(envelope(**body), CONFIG)

    def test_payload_size_and_messages_limited(self):
        for body in [{"messages": [{"role": "user", "content": "x" * 65536}]},
                     {"messages": []}, {"messages": [{"role": "user", "content": [{"image_url": "http://internal"}]}]}]:
            with self.assertRaises(ValueError):
                validate_model_request(envelope(**body), CONFIG)

    def test_no_provider_secret_in_container_command(self):
        session = gateway.Session(gateway.Config(token="a" * 40), "f" * 64, ModelBroker(CONFIG))
        command = " ".join(session.command())
        self.assertNotIn(SECRET, command)
        self.assertNotIn("TOKENPLAN_API_KEY", command)
        self.assertIn("LLM_API_KEY=sandbox-broker", command)
        self.assertIn("--network=none", command)

    def test_provider_configuration_rejects_redirectable_or_credential_urls(self):
        for url in ["http://provider.example/v1", "https://user:pass@provider.example/v1", "https://provider.example/v1?url=x"]:
            with patch.dict("os.environ", {"TOKENPLAN_BASE_URL": url}, clear=True), self.assertRaises(ValueError):
                ModelConfig.from_environment()


class ModelBrokerTests(unittest.TestCase):
    def call(self, broker=None, value=None):
        return (broker or ModelBroker(CONFIG)).request(value or envelope(), "user-chapter",
                                                     time.monotonic() + 2, threading.Event())

    def connection(self, response=None):
        connection = Mock()
        connection.sock = None
        connection.getresponse.return_value = response or FakeResponse()
        return connection

    def test_missing_key_never_connects_or_fabricates_content(self):
        with patch("model_broker.http.client.HTTPSConnection") as connection:
            value = self.call(ModelBroker(ModelConfig(model="test-model")))
            self.assertEqual(value["status"], 503)
            self.assertIn("not configured", value["body"])
            connection.assert_not_called()

    def test_fixed_destination_and_server_only_authorization(self):
        connection = self.connection()
        with patch("model_broker.http.client.HTTPSConnection", return_value=connection) as factory:
            value = self.call()
        factory.assert_called_once()
        self.assertEqual(factory.call_args.args, ("provider.example", 443))
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("POST", "/v1/chat/completions"))
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer " + SECRET)
        self.assertEqual(value["status"], 200)
        self.assertIn("real fixture", value["body"])
        self.assertNotIn(SECRET, json.dumps(value))

    def test_redirects_are_never_followed(self):
        connection = self.connection(FakeResponse(status=302))
        with patch("model_broker.http.client.HTTPSConnection", return_value=connection):
            value = self.call()
        self.assertEqual(value["status"], 502)
        self.assertIn("redirects", value["body"])
        self.assertEqual(connection.request.call_count, 1)

    def test_provider_secret_redacted_if_upstream_echoes_it(self):
        connection = self.connection(FakeResponse(json.dumps({"error": SECRET}).encode(), status=400))
        with patch("model_broker.http.client.HTTPSConnection", return_value=connection):
            value = self.call()
        self.assertEqual(value["status"], 400)
        self.assertNotIn(SECRET, value["body"])
        self.assertIn("REDACTED", value["body"])

    def test_real_sse_bytes_are_buffered_without_inventing_events(self):
        sse = b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
        connection = self.connection(FakeResponse(sse, content_type="text/event-stream"))
        with patch("model_broker.http.client.HTTPSConnection", return_value=connection):
            value = self.call(value=envelope(stream=True))
        self.assertEqual(value["body"], sse.decode())
        self.assertEqual(value["contentType"], "text/event-stream")

    def test_upstream_output_cap(self):
        connection = self.connection(FakeResponse(b"x" * (MAX_MODEL_RESPONSE + 1)))
        with patch("model_broker.http.client.HTTPSConnection", return_value=connection):
            value = self.call()
        self.assertEqual(value["status"], 502)
        self.assertIn("512 KiB", value["body"])

    def test_model_rate_limit_prevents_network_request(self):
        broker = ModelBroker(CONFIG)
        broker.user_rate.allow = Mock(return_value=False)
        with patch("model_broker.http.client.HTTPSConnection") as factory:
            self.assertEqual(self.call(broker)["status"], 429)
            factory.assert_not_called()

    def test_concurrency_limit_prevents_network_request(self):
        broker = ModelBroker(CONFIG)
        broker.slots.acquire()
        broker.slots.acquire()
        with patch("model_broker.http.client.HTTPSConnection") as factory:
            self.assertEqual(self.call(broker)["status"], 429)
            factory.assert_not_called()

    def test_http_failure_does_not_expose_host_diagnostics(self):
        with patch("model_broker.http.client.HTTPSConnection", side_effect=OSError(SECRET)):
            value = self.call()
        self.assertEqual(value["status"], 502)
        self.assertNotIn(SECRET, value["body"])


class ProtocolTests(unittest.TestCase):
    def test_rpc_is_dispatched_while_waiting_for_execution(self):
        broker = ModelBroker(CONFIG)
        broker.request = Mock(return_value={"rpc": "model_result", "id": "a" * 32,
                                           "status": 200, "contentType": "application/json", "body": "{}"})
        session = gateway.Session(gateway.Config(token="a" * 40), "f" * 64, broker)
        session.process = Mock(stdin=io.BytesIO())
        session.messages.put(envelope())
        session.messages.put({"status": "ok", "stdout": "done", "stderr": ""})
        result = session.receive(2, allow_model=True)
        self.assertEqual(result["stdout"], "done")
        self.assertEqual(json.loads(session.process.stdin.getvalue())["rpc"], "model_result")
        broker.request.assert_called_once()

    def test_rpc_rejected_during_kernel_startup(self):
        session = gateway.Session(gateway.Config(token="a" * 40), "f" * 64)
        session.messages.put(envelope())
        with self.assertRaises(gateway.SessionLost):
            session.receive(1)

    def test_guest_loopback_urllib_gets_exact_rpc_reply(self):
        holder = {}
        def send(request):
            holder["request"] = request
            broker.deliver({"rpc": "model_result", "id": request["id"], "status": 200,
                            "contentType": "application/json", "body": '{"choices":[]}'} )
        broker = GuestModelBroker(send, port=0)
        broker.start()
        try:
            url = "http://127.0.0.1:" + str(broker.server.server_port) + "/v1/chat/completions"
            request = urllib.request.Request(url, data=json.dumps(envelope()["body"]).encode(),
                headers={"Authorization": "Bearer sandbox-broker", "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=2) as reply:
                self.assertEqual(reply.read(), b'{"choices":[]}')
            self.assertEqual(holder["request"]["path"], "/v1/chat/completions")
            self.assertNotIn("Authorization", holder["request"])
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, data=b"{}"), timeout=2)
            self.assertEqual(error.exception.code, 401)
        finally:
            broker.server.shutdown()
            broker.server.server_close()


if __name__ == "__main__":
    unittest.main()
