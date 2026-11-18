# llm.py：整本下册和模型说话的唯一入口（Token Plan 统一接入 + 流式 + 缓存 + 预算保险丝 + 三分法）
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
    """明确失败：密钥错、地址错、参数错，或者重试多次依然连不上。"""


class NotDone(LLMError):
    """它回了话，但这次不能算完成（写到一半被掐断、被拦截、或递来工具纸条）。"""


class BudgetExceeded(LLMError):
    """触发单次运行预算保险丝，防止死循环或批量脚本跑飞。"""


def _cfg():
    base = os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_MODEL", DEFAULT_MODEL)
    if not key:
        raise LLMError("未设置环境变量 LLM_API_KEY，请先 export LLM_API_KEY=你的密钥")
    return base, key, model


def _check_budget():
    max_calls = int(os.environ.get("MYKB_MAX_CALLS", "50"))
    if LEDGER["calls"] >= max_calls:
        raise BudgetExceeded(f"本次真实调用已达上限 {max_calls} 次（可用 MYKB_MAX_CALLS 调高）")


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
                raise LLMError(f"连不上（状态未知，请勿盲目重发写操作）：{e}") from None
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
    """成了、没成、还是半截：只认 stop 且有正文。"""
    why = choice.get("finish_reason")
    text = (choice.get("message") or {}).get("content") or ""
    if why == "stop" and text.strip():
        return
    reasons = {
        "length": f"写到上限被掐断了，只有前半截：{text[-30:]!r}",
        "content_filter": "被平台的内容过滤拦下了",
        "tool_calls": "它没说话，递来了一张要用工具的纸条",
    }
    raise NotDone(reasons.get(why, f"停下的原因是 {why!r}，内容{'为空' if not text.strip() else '不完整'}"))


def _cache_key(model, messages, temperature, extra):
    payload = json.dumps({"model": model, "messages": messages, "temperature": temperature, "extra": extra}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def chat(messages, model=None, temperature=0, use_cache=None, **extra):
    """交出一串对话，拿回它的回答。默认开启本地缓存（MYKB_CACHE=0 可关闭）。"""
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


def stream(messages, model=None, temperature=0):
    """一边写一边交，降低首字等待。"""
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    _, _, default_model = _cfg()
    _check_budget()
    began = time.time()
    body = {
        "model": model or default_model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    usage = None
    with _post(body) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[5:])
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices", []):
                piece = (choice.get("delta") or {}).get("content")
                if piece:
                    yield piece
    _book(usage, began)


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
