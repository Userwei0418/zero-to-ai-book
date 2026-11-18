"""Host-only, optional model broker. Never copy this module into the guest image."""
from __future__ import annotations

import contextlib
import http.client
import json
import os
import queue
import re
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass, field

from validation import RateLimiter

MAX_MODEL_REQUEST = 65_536
MAX_MODEL_RESPONSE = 524_288
RPC_ID = re.compile(r"^[a-f0-9]{32}$")


@dataclass
class ModelConfig:
    key: str = field(default="", repr=False)
    base_url: str = "https://token.sensetime.com/api/v1"
    model: str = "sensenova-6.8-flash"
    timeout_seconds: int = 25
    calls_per_execution: int = 12

    @classmethod
    def from_environment(cls):
        config = cls(key=os.environ.get("TOKENPLAN_API_KEY", ""),
                     base_url=os.environ.get("TOKENPLAN_BASE_URL", cls.base_url).rstrip("/"),
                     model=os.environ.get("TOKENPLAN_MODEL", cls.model),
                     timeout_seconds=int(os.environ.get("SANDBOX_MODEL_TIMEOUT_SECONDS", "25")),
                     calls_per_execution=int(os.environ.get("SANDBOX_MODEL_CALLS_PER_EXECUTION", "12")))
        parsed = urllib.parse.urlsplit(config.base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("TOKENPLAN_BASE_URL must be a fixed HTTPS URL without credentials/query/fragment")
        if any(c.isspace() for c in config.base_url) or len(config.base_url) > 2048:
            raise ValueError("invalid provider URL")
        if not 1 <= config.timeout_seconds <= 45 or not 1 <= config.calls_per_execution <= 32:
            raise ValueError("model timeout must be 1–45 seconds; calls per execution must be 1–32")
        if not config.model or len(config.model) > 128 or any(ord(c) < 32 for c in config.model):
            raise ValueError("invalid configured model name")
        if "\r" in config.key or "\n" in config.key:
            raise ValueError("invalid provider key")
        return config


def broker_error(identifier: str, status: int, message: str) -> dict:
    return {"rpc": "model_result", "id": identifier, "status": status,
            "contentType": "application/json", "body": json.dumps({"error": {"message": message, "type": "sandbox_model_broker"}})}


def validate_model_request(envelope: dict, config: ModelConfig) -> tuple[str, bytes]:
    if set(envelope) != {"rpc", "id", "method", "path", "body"} or envelope.get("rpc") != "model":
        raise ValueError("invalid model RPC envelope")
    identifier = envelope.get("id")
    if not isinstance(identifier, str) or not RPC_ID.fullmatch(identifier):
        raise ValueError("invalid model RPC id")
    if envelope["method"] != "POST" or envelope["path"] != "/v1/chat/completions":
        raise ValueError("only POST /v1/chat/completions is supported")
    body = envelope["body"]
    if not isinstance(body, dict):
        raise ValueError("model body must be an object")
    allowed = {"model", "messages", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens",
               "stop", "seed", "response_format", "tools", "tool_choice", "parallel_tool_calls",
               "presence_penalty", "frequency_penalty", "n", "stream_options"}
    if set(body) - allowed:
        raise ValueError("unsupported model request fields")
    if body.get("model") != config.model:
        raise ValueError("only the operator-configured model is allowed")
    messages = body.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 100:
        raise ValueError("messages must contain 1–100 items")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "developer", "user", "assistant", "tool"}:
            raise ValueError("invalid message role")
        if message.get("content") is not None and not isinstance(message["content"], str):
            raise ValueError("this broker supports text messages only")
    if "stream" in body and not isinstance(body["stream"], bool):
        raise ValueError("stream must be boolean")
    if body.get("n", 1) != 1:
        raise ValueError("only one completion per call is allowed")
    body = dict(body)
    for key in ("max_tokens", "max_completion_tokens"):
        if key in body and (isinstance(body[key], bool) or not isinstance(body[key], int) or not 1 <= body[key] <= 2048):
            raise ValueError("completion token limit must be 1–2048")
    if "max_tokens" not in body and "max_completion_tokens" not in body:
        body["max_tokens"] = 1024
    if "tools" in body and (not isinstance(body["tools"], list) or len(body["tools"]) > 16):
        raise ValueError("at most 16 tool definitions are allowed")
    encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_MODEL_REQUEST:
        raise ValueError("model request exceeds 64 KiB")
    return identifier, encoded


class ModelBroker:
    def __init__(self, config: ModelConfig | None = None):
        self.config = config or ModelConfig()
        self.slots = threading.BoundedSemaphore(2)
        self.global_rate = RateLimiter(maximum=120, max_keys=1)
        self.user_rate = RateLimiter(maximum=120, window=3600, max_keys=4096)

    @property
    def configured(self):
        return bool(self.config.key)

    def request(self, envelope: dict, identity: str, deadline: float, cancelled: threading.Event) -> dict:
        candidate = envelope.get("id", "")
        identifier = candidate if isinstance(candidate, str) and RPC_ID.fullmatch(candidate) else "invalid"
        try:
            identifier, data = validate_model_request(envelope, self.config)
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            return broker_error(identifier, 400, str(error)[:200])
        if not self.configured:
            return broker_error(identifier, 503, "Model provider is not configured on the sandbox host; no model request was made.")
        if not self.user_rate.allow(identity) or not self.global_rate.allow("provider"):
            return broker_error(identifier, 429, "Model call quota exceeded (120 per user/chapter/hour; 120 globally/minute).")
        if not self.slots.acquire(blocking=False):
            return broker_error(identifier, 429, "Model provider concurrency limit reached.")
        deadline = min(deadline, time.monotonic() + self.config.timeout_seconds)
        result: queue.Queue = queue.Queue(maxsize=1)
        connection_holder = []
        abandoned = threading.Event()

        def close_connection():
            if connection_holder:
                connection = connection_holder[0]
                with contextlib.suppress(OSError):
                    if connection.sock:
                        connection.sock.shutdown(socket.SHUT_RDWR)
                with contextlib.suppress(OSError):
                    connection.close()

        def worker():
            try:
                parsed = urllib.parse.urlsplit(self.config.base_url)
                connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443,
                                                         timeout=max(0.1, deadline - time.monotonic()))
                connection_holder.append(connection)
                connection.connect()
                if cancelled.is_set() or abandoned.is_set() or time.monotonic() >= deadline:
                    return
                # The destination, path prefix, model and Authorization belong
                # exclusively to trusted operator configuration. No redirects.
                path = parsed.path.rstrip("/") + "/chat/completions"
                connection.request("POST", path, body=data,
                    headers={"Authorization": "Bearer " + self.config.key, "Content-Type": "application/json",
                             "Accept": "application/json, text/event-stream", "Accept-Encoding": "identity"})
                upstream = connection.getresponse()
                if 300 <= upstream.status < 400:
                    result.put(broker_error(identifier, 502, "Provider redirects are not permitted."))
                    return
                content_type = upstream.getheader("Content-Type", "application/json").split(";", 1)[0].strip().lower()
                if content_type not in {"application/json", "text/event-stream"}:
                    result.put(broker_error(identifier, 502, "Provider returned an unsupported content type."))
                    return
                body = bytearray()
                while True:
                    if cancelled.is_set() or abandoned.is_set() or time.monotonic() >= deadline:
                        return
                    if connection.sock:
                        connection.sock.settimeout(max(0.1, deadline - time.monotonic()))
                    chunk = upstream.read1(min(8192, MAX_MODEL_RESPONSE + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                    if len(body) > MAX_MODEL_RESPONSE:
                        result.put(broker_error(identifier, 502, "Provider response exceeded 512 KiB."))
                        return
                text = bytes(body).decode("utf-8", errors="replace").replace(self.config.key, "[REDACTED]")
                result.put({"rpc": "model_result", "id": identifier, "status": upstream.status,
                            "contentType": content_type, "body": text})
            except (OSError, ValueError, http.client.HTTPException):
                with contextlib.suppress(queue.Full):
                    result.put_nowait(broker_error(identifier, 502, "The configured model provider could not complete the request."))
            finally:
                close_connection()
                self.slots.release()

        threading.Thread(target=worker, daemon=True).start()
        while not cancelled.is_set() and time.monotonic() < deadline:
            try:
                return result.get(timeout=min(0.2, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
        abandoned.set()
        close_connection()
        return broker_error(identifier, 504, "Model request exceeded the remaining execution time or was interrupted.")
