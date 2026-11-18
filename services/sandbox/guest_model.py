"""Container-local urllib-compatible endpoint; all external I/O uses host RPC.

The loopback listener also supports Python launched through subprocess. It has
no provider credential and cannot create an arbitrary host network request.
"""
import contextlib
import json
import queue
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

from validation import authenticated


class GuestModelBroker:
    def __init__(self, send, port=8765):
        self.send = send
        self.pending = {}
        self.lock = threading.Lock()
        self.server = HTTPServer(("127.0.0.1", port), ModelHandler)
        self.server.broker = self

    def start(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def deliver(self, response):
        with self.lock:
            pending = self.pending.get(response.get("id"))
        if pending:
            with contextlib.suppress(queue.Full):
                pending.put_nowait(response)

    def request(self, body):
        identifier = uuid.uuid4().hex
        pending = queue.Queue(maxsize=1)
        with self.lock:
            self.pending[identifier] = pending
        try:
            self.send({"rpc": "model", "id": identifier, "method": "POST", "path": "/v1/chat/completions", "body": body})
            return pending.get(timeout=65)
        finally:
            with self.lock:
                self.pending.pop(identifier, None)


class ModelHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *unused):
        pass

    def reply(self, status, body, content_type="application/json"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.wfile.write(data)

    def error(self, status, message):
        self.reply(status, json.dumps({"error": {"type": "sandbox_model_broker", "message": message}}))

    def do_GET(self):
        self.error(405, "This is the local sandbox broker; use POST /v1/chat/completions. Provider connectivity was not checked.")

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.error(404, "Only the configured chat/completions operation is available.")
            return
        if not authenticated(self.headers.get("Authorization"), "sandbox-broker"):
            self.error(401, "Use the LLM_API_KEY value provided by this sandbox; it is a local placeholder, not a provider secret.")
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                raise ValueError("one Content-Length is required")
            length = int(lengths[0])
            if not 0 <= length <= 65536:
                self.error(413, "Model request must be at most 64 KiB.")
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete request")
            response = self.server.broker.request(json.loads(raw))
            self.reply(response["status"], response["body"], response["contentType"])
        except (ValueError, UnicodeError, RecursionError):
            self.error(400, "Invalid JSON model request.")
        except (OSError, queue.Empty):
            self.error(504, "Model broker deadline exceeded.")
