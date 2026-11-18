# llm.py（第 02 章升级版）：在 ch01 基础上增加 ask_json()，支持 response_format + 严格 Schema 校验与最多 1 次纠错重试
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://token.sensetime.com/api/v1"
DEFAULT_MODEL = "sensenova-6.8-flash"
CACHE_DIR = os.environ.get("MYKB_CACHE_DIR", os.path.join(os.path.dirname(__file__), ".cache"))

LEDGER = {
    "calls": 0,
    "cache_hits": 0,
    "prompt": 0,
    "completion": 0,
    "seconds": 0.0,
    "unknown": 0,
}

RETRY_CODES = {429, 500, 502, 503, 504}


class LLMError(Exception):
    pass


class NotDone(LLMError):
    pass


class BudgetExceeded(LLMError):
    pass


class SchemaError(LLMError):
    """模型回来的 JSON 虽然语法对，但缺字段、类型不对或超出约定词表。"""


def _cfg():
    base = os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_MODEL", DEFAULT_MODEL)
    if not key:
        raise LLMError("未设置环境变量 LLM_API_KEY")
    return base, key, model


def _check_budget():
    max_calls = int(os.environ.get("MYKB_MAX_CALLS", "50"))
    if LEDGER["calls"] >= max_calls:
        raise BudgetExceeded(f"本次真实调用已达上限 {max_calls} 次")


def _post(body, timeout=120):
    base, key, _ = _cfg()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            if e.code not in RETRY_CODES or attempt == 3:
                raise LLMError(f"HTTP {e.code}：{detail}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise LLMError(f"连不上：{e}") from None
        time.sleep(2 ** attempt)


def _book(usage, began):
    LEDGER["calls"] += 1
    if not usage or "completion_tokens" not in usage:
        LEDGER["unknown"] += 1
    else:
        LEDGER["prompt"] += usage.get("prompt_tokens", 0)
        LEDGER["completion"] += usage.get("completion_tokens", 0)
    LEDGER["seconds"] += time.time() - began


def _parse(raw):
    try:
        return json.loads(raw)
    except ValueError:
        if '"content":' not in raw:
            raise LLMError(f"回来的内容不完整：{raw[-80:]!r}") from None
        start = raw.index('"content":') + len('"content":')
        content, _ = json.JSONDecoder().raw_decode(raw, start)
        usage = {
            k: int(m.group(1))
            for k in ("prompt_tokens", "completion_tokens")
            for m in [re.search(f'"{k}":(\\d+)', raw)]
            if m
        }
        return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": usage or None}


def done(choice):
    why = choice.get("finish_reason")
    text = (choice.get("message") or {}).get("content") or ""
    if why == "stop" and text.strip():
        return
    raise NotDone(f"未完成（finish_reason={why!r}）")


def _cache_key(model, messages, temperature, extra):
    payload = json.dumps({"model": model, "messages": messages, "temperature": temperature, "extra": extra}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def chat(messages, model=None, temperature=0, use_cache=None, **extra):
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    _, _, default_model = _cfg()
    m = model or default_model
    cache_on = (os.environ.get("MYKB_CACHE", "1") != "0") if use_cache is None else use_cache

    key = _cache_key(m, messages, temperature, extra)
    cache_path = os.path.join(CACHE_DIR, f"{key}.json")
    if cache_on and temperature == 0 and os.path.exists(cache_path):
        LEDGER["cache_hits"] += 1
        return json.load(open(cache_path, encoding="utf-8"))["content"]

    _check_budget()
    began = time.time()
    body = {"model": m, "messages": messages, "temperature": temperature, **extra}
    with _post(body) as resp:
        raw = resp.read().decode("utf-8", "replace")
    data = _parse(raw)
    _book(data.get("usage"), began)
    choice = data["choices"][0]
    done(choice)
    content = choice["message"]["content"]

    if cache_on and temperature == 0:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"model": m, "content": content}, f, ensure_ascii=False, indent=2)
    return content


def extract_json(text):
    """从可能包了 ```json ... ``` 的回复里剥出 JSON 对象。"""
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s.strip())
    return json.loads(s)


def ask_json(messages, validator, model=None, use_cache=None):
    """要求模型交出严格合规的 JSON；若校验失败，把具体错因递回去最多重试 1 次。"""
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    msgs = list(messages)
    last_err = None
    for attempt in range(2):
        raw = chat(msgs, model=model, temperature=0, use_cache=use_cache, response_format={"type": "json_object"})
        try:
            obj = extract_json(raw)
            return validator(obj)
        except (ValueError, SchemaError) as e:
            last_err = e
            if attempt == 0:
                msgs = msgs + [
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": f"格式校验未通过：{e}。请只输出修正后的合法 JSON，不要任何解释。"},
                ]
    raise SchemaError(f"连续两次未通过格式校验：{last_err}")


def bill(price_in=None, price_out=None):
    unknown = f"（含 {LEDGER['unknown']} 次账不全）" if LEDGER["unknown"] else ""
    line = (
        f"真实调用 {LEDGER['calls']} 次，命中缓存 {LEDGER['cache_hits']} 次，"
        f"读 {LEDGER['prompt']} / 写 {LEDGER['completion']} token，"
        f"耗时 {LEDGER['seconds']:.1f} 秒{unknown}"
    )
    if price_in is not None and price_out is not None:
        cost = LEDGER["prompt"] / 1e6 * price_in + LEDGER["completion"] / 1e6 * price_out
        line += f"，约 {cost:.4f} 元"
    return line
