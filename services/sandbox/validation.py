"""Shared, dependency-free validation. No user code runs in the gateway."""
from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time
from collections import deque

MAX_BODY_BYTES = 2_097_152
MAX_CODE_BYTES = 65_536
MAX_FILE_BYTES = 1_179_648
MAX_FILES_BYTES = 1_572_864
MAX_FILES = 160
MAX_OUTPUT_BYTES = 65_536
MAX_IMAGE_BYTES = 524_288
MAX_IMAGES = 3
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
COMPONENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$")


class InvalidRequest(ValueError):
    pass


def authenticated(header: str | None, token: str) -> bool:
    """Compare the complete authorization value without prefix-dependent timing."""
    return secrets.compare_digest((header or "").encode("utf-8"),
                                  ("Bearer " + token).encode("utf-8"))


def validate_path(path: object) -> str:
    if not isinstance(path, str) or len(path) > 240:
        raise InvalidRequest("file path must be a relative path of at most 240 characters")
    parts = path.split("/")
    if len(parts) > 8 or any(not COMPONENT.fullmatch(part) for part in parts):
        raise InvalidRequest("file paths must use safe relative workspace components")
    return path


def validate_payload(payload: object, action: str) -> dict:
    if not isinstance(payload, dict):
        raise InvalidRequest("request must be a JSON object")
    allowed = {"sessionKey", "chapterId"}
    if action == "execute":
        allowed |= {"code", "cellId", "files"}
    if set(payload) - allowed:
        raise InvalidRequest("unknown request fields")
    result = {}
    for key in ("sessionKey", "chapterId"):
        value = payload.get(key)
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise InvalidRequest(f"{key} must contain 1–128 letters, digits, underscores or hyphens")
        result[key] = value
    if action != "execute":
        return result
    code = payload.get("code")
    if not isinstance(code, str) or len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise InvalidRequest("code must be a string of at most 65536 UTF-8 bytes")
    cell_id = payload.get("cellId")
    if not isinstance(cell_id, str) or not IDENTIFIER.fullmatch(cell_id):
        raise InvalidRequest("cellId must contain 1–128 letters, digits, underscores or hyphens")
    raw_files = payload.get("files", {})
    if isinstance(raw_files, dict):
        entries = list(raw_files.items())
    elif isinstance(raw_files, list):
        if any(not isinstance(f, dict) or set(f) != {"path", "content"} for f in raw_files):
            raise InvalidRequest("files list entries require exactly path and content")
        entries = [(f["path"], f["content"]) for f in raw_files]
    else:
        raise InvalidRequest("files must be an object mapping paths to text, or a list of path/content objects")
    if len(entries) > MAX_FILES:
        raise InvalidRequest(f"at most {MAX_FILES} files may be supplied")
    files, total = {}, 0
    for path, content in entries:
        path = validate_path(path)
        if path in files:
            raise InvalidRequest("duplicate file paths")
        if not isinstance(content, str):
            raise InvalidRequest("file contents must be strings")
        size = len(content.encode("utf-8"))
        total += size
        if size > MAX_FILE_BYTES or total > MAX_FILES_BYTES:
            raise InvalidRequest("file content quota exceeded")
        files[path] = content
    result.update(code=code, cellId=cell_id, files=files)
    return result


def session_id(payload: dict) -> str:
    value = payload["sessionKey"] + "\x00" + payload["chapterId"]
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class RateLimiter:
    def __init__(self, maximum: int = 60, window: float = 60, max_keys: int = 4096):
        self.maximum, self.window, self.max_keys = maximum, window, max_keys
        self.events: dict[str, deque] = {}
        self.lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self.lock:
            for old_key in list(self.events):
                if not self.events[old_key] or self.events[old_key][-1] <= now - self.window:
                    del self.events[old_key]
            if key not in self.events:
                if len(self.events) >= self.max_keys:
                    return False
                self.events[key] = deque()
            events = self.events[key]
            while events and events[0] <= now - self.window:
                events.popleft()
            if len(events) >= self.maximum:
                return False
            events.append(now)
            return True
