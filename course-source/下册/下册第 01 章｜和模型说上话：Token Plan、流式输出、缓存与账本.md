# 下册第 01 章｜和模型说上话：Token Plan、流式输出、缓存与账本

*这一章做完：你手里有一份自动写好的《上册知识库目录.md》，二十五篇《上册》笔记每篇一行，标题、一句话摘要、三个标签。更重要的是，你亲手写出了一生受用的 `llm.py`——统一接入商汤 Token Plan，自带流式输出、本地缓存、预算保险丝、残信兜底和“成了 / 没成 / 不知道”三分法。对应上册第 00 章。*

## 把《上册》装进抽屉之前

上册十四章，你一直站在历史现场里看：从 1956 年的达特茅斯，到感知机、反向传播、强化学习、Transformer、RAG、Tool Calling、MCP 和多 Agent 协作。看懂了，不等于会做。

到了下册，你手头刚好有一套现成的、四十多万字的知识库语料——就是你在《上册》读过的那二十五篇正文、番外和教学视频。

我们直接**拿《上册》当你的第一座知识库**，从一个空文件夹开始，一行一行敲。写完这本下册，你可以直接在终端里问它：“第 02 章里感知机为什么卡在楼梯灯？”“第 07 章的一刀切教训是什么？”它会翻遍全部笔记，给出带着精确 `[文件名:行号]` 出处的回答；哪天想换成你自己的 Obsidian 笔记库，只要在命令行里改一个目录路径就行。

![[零基础学AI/attachments/下册第 1 章｜和模型说上话：一封信，一本账/EnR2bacEcodMuNxD6yGcQcTYnxO.png|抽屉里塞满了笔记。先让它递过来一页目录。]]

这一章的目标很小：先让程序稳定地和模型说上话，然后扫描《上册》全部二十五篇笔记，自动写出一份目录。

---

## 第一封信：不用任何封装，亲手寄一次

上册第 00 章说过，和模型说话，就是往一个地址寄一封信，再等它回一封。为了看清信封里面到底装了什么，这一步我们不用任何第三方 SDK，只用 Python 自带的 `urllib.request`，亲手把请求寄出去、把回执原样印出来。

先把三样东西放进环境变量。密钥就是钱，绝不写进任何代码文件：

```bash
export LLM_BASE_URL="https://token.sensetime.com/api/v1"
export LLM_API_KEY="你的密钥"
export LLM_MODEL="sensenova-6.8-flash"
```

上面是本书统一使用的商汤 **Token Plan** 接口。只要兼容 OpenAI Chat Completions 协议，换成 DeepSeek、阿里百炼或者你本机跑的 Ollama 小模型，也只需要改这三行环境变量，代码一行不用动。

现在写第一个程序 `raw.py`：

```python
# raw.py：不用任何封装，亲手向 Token Plan 寄出第一封信，把请求和完整回执原样印出来
import json
import os
import urllib.request

BASE_URL = os.environ.get("LLM_BASE_URL", "https://token.sensetime.com/api/v1").rstrip("/")
API_KEY = os.environ["LLM_API_KEY"]
MODEL = os.environ.get("LLM_MODEL", "sensenova-6.8-flash")

body = {
    "model": MODEL,
    "messages": [{"role": "user", "content": "用一句话说说，把《上册》笔记装进个人知识库有什么用？"}],
}
print("寄出去的：")
print(json.dumps(body, ensure_ascii=False, indent=2))

req = urllib.request.Request(
    BASE_URL + "/chat/completions",
    data=json.dumps(body).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
)
with urllib.request.urlopen(req, timeout=60) as resp:
    data = json.loads(resp.read().decode("utf-8"))

if "id" in data:
    data["id"] = data["id"][:14] + "…"
print("\n收回来的：")
print(json.dumps(data, ensure_ascii=False, indent=2))
```

跑一遍，盯着收回来的这封信看：

```
寄出去的：
{
  "model": "sensenova-6.8-flash",
  "messages": [
    {
      "role": "user",
      "content": "用一句话说说，把《上册》笔记装进个人知识库有什么用？"
    }
  ]
}

收回来的：
{
  "id": "chatcmpl-863c…",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "把《上册》笔记装进个人知识库后，你可以随时用自然语言精准检索任意概念与代码出处，把读过的理论真正变成日常可用的工作台。"
      }
    }
  ],
  "created": 1794583055,
  "model": "sensenova-6.8-flash",
  "object": "chat.completion",
  "usage": {
    "prompt_tokens": 229,
    "completion_tokens": 39,
    "total_tokens": 268
  }
}
```

请把收回来的这封信从头到尾读一遍，三个地方值得停下来认熟：

**1. `message.content` 是它的回答。** 平时在聊天窗口里看到的，就只有这一段。

**2. `finish_reason` 是它为什么停下。** `stop` 代表正常说完。要是你看见 `length`，说明它写到最大长度被一刀掐断了，回答只有前半截；要是看见 `tool_calls`，说明它没说话，而是从门缝里递出来一张“要调工具的纸条”。

**3. `usage` 是这一封信的小账。** 它读了多少（`prompt_tokens`），写了多少（`completion_tokens`）。平台按这两个数字算钱。你会注意到：我寄出去的明明只有二十几个字，它却说读了 229 个 token。多出来的那两百个，通常是平台在你的话前面悄悄垫了一段系统开场白。不同平台、不同模型，这个底数都不一样——所以**算账从来不能靠猜，必须读回执里的 `usage`**。

![[零基础学AI/attachments/下册第 1 章｜和模型说上话：一封信，一本账/Q5KXbpo1hoqLHjxjrRycpWq4nHf.png|你拿着放大镜读它回的信。角落里有一行小字是账单。]]

![[零基础学AI/attachments/下册第 1 章｜和模型说上话：一封信，一本账/SULYbuqjEoIO9GxpFCKcxlhCnJf.png|一次请求，一个来回。]]

---

## 把它包成 `llm.py`：缓存、预算保险丝与“成/败/未知”三分法

每次发请求都要写二十行 `urllib.request`，太累了。更重要的是，直接拿 `raw.py` 去扫《上册》25 篇长文，不出十分钟就会撞上四个真实的工程麻烦：

1. **调试一次烧一次钱**：改完一行输出格式重跑，25 篇笔记又得重新问一遍。如果能把 `temperature=0` 的确定性回答缓存到本地，没改过的笔记零耗时、零费用直接返回，开发体验会好十倍。
2. **死循环跑飞风险**：后面第 06 章放开自主循环后，万一终止条件写歪了，一分钟能刷掉几百次调用。代码里必须焊死一只**单次运行预算保险丝**（比如默认最多真实请求 50 次）。
3. **报错分不清该不该重试**：密钥错、模型名拼错、地址少写 `/v1`，重试一百次也是错；但 429 限流、502 网关抖动或超时，等 1 秒、2 秒、4 秒再试往往就能通。
4. **超时不等于没干成**：信可能已经寄到对面、对面也写完了，只是回执在半路丢了。对只读问答，重问一次无非多花一点钱；可等到第 05 章和第 10 章能往硬盘写笔记时，“超时就盲目重发”就会把同一篇笔记写两遍。

所以我们在 `课件/ch01/llm.py` 里把这四道防线一次性写齐：

```python
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
    """正常情况直接 json.loads；若平台偶尔把末尾 usage 截断而 content 完整，则先把回答抠出来。"""
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
```

仔细看 `llm.py` 里两个容易被忽略的设计：

- **`_book()` 里专门记了 `unknown`**：万一某次响应没带回 `completion_tokens`（或者被截断了），绝不能写成 `0`，因为 `0` 的意思是“免费”，而真相是“不知道”。
- **缓存只在 `temperature == 0` 时生效**：带随机性的采样（`temperature > 0`）本来就希望每次有点不一样，强制缓存反而会破坏实验。

> **老办法，新地方**
>
> “成了、没成、结果未知”这三分法，不是大模型时代才发明的。银行转账、网上下单早就为它头疼了几十年：钱扣了，回执没到，这一单算成没成？那一行的老规矩是：给每次操作一个编号，状态未知时先去查，查清了再决定要不要重来。第 06 章断点续传和第 10 章幂等去重，用的都是这一条老规矩。

---

## 一边写一边交：流式输出到底省了什么？

问它一个稍微长点的问题，等它全部写完再一次交出来，你往往要盯着空白屏幕干等一两秒。打开 `"stream": True` 后，服务端会以 `data: {...}` 的形式一行一行把刚吐出来的字推过来。

写一个 `streaming.py`，把同一个问题用两种方式各跑一遍，量一量两个时间：第一个字什么时候出来，全部什么时候写完：

```python
# streaming.py：对比一次交完与流式输出的首字等待时间
import time
from llm import chat, stream

Q = [{"role": "user", "content": "我想把《零基础学 AI》上册的笔记搭成一个能问答的知识库，请用三点说说第一步该注意什么。"}]

t = time.time()
ans = chat(Q, use_cache=False)
print(f"一次交完：首字与全文字均在 {time.time() - t:.2f} 秒出现（共 {len(ans)} 字）\n")

t, first, pieces = time.time(), None, []
for piece in stream(Q):
    if first is None:
        first = time.time() - t
    pieces.append(piece)
    print(piece, end="", flush=True)
print(f"\n\n流式输出：首字在 {first:.2f} 秒出现，全部写完在 {time.time() - t:.2f} 秒（共 {len(pieces)} 小段）")
```

```
一次交完：首字与全文字均在 1.62 秒出现（共 210 字）
流式输出：首字在 0.31 秒出现，全部写完在 1.54 秒（共 75 小段）
```

全部写完，两种办法差不多都是一秒半。但**第一个字出现的时间，从 1.62 秒压到了 0.31 秒**。总时间没省，省的是你盯着黑框怀疑程序是不是卡死的那一秒多。

![[零基础学AI/attachments/下册第 1 章｜和模型说上话：一封信，一本账/Eo8pbjposoZURnx3SwncvM3Vnb1.png|一个等着整页交过来，一个已经在读头几行了。]]

---

## 故意弄错几样：把常见报错的脸认熟

与其等半夜批处理跑到一半突然崩掉，不如现在就故意写个 `oops.py` 踩一遍坑，把最常见的几种报错脸谱认熟：

```python
# oops.py：故意踩四种常见坑，把出错的脸认熟
import os
import llm


def attempt(label, **env):
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        llm.chat([{"role": "user", "content": "你好"}], use_cache=False)
        print(f"{label}：居然通了")
    except llm.LLMError as e:
        print(f"{label}：{e}")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


base = os.environ.get("LLM_BASE_URL", llm.DEFAULT_BASE_URL)
key = os.environ.get("LLM_API_KEY", "sk-placeholder")

attempt("密钥错了一位", LLM_API_KEY=key[:-1] + "x")
attempt("模型名拼错", LLM_MODEL="sensenova-not-exist")
attempt("地址少了 /v1", LLM_BASE_URL=base.rstrip("/").rsplit("/v1", 1)[0])
attempt("地址写错了域名", LLM_BASE_URL="https://api.invalid.example/v1")
```

跑完四下，四张脸一目了然：

```
密钥错了一位：HTTP 401：{"code":"authentication_error","message":"incorrect API key provided"}
模型名拼错：HTTP 400：{"code":"invalid","message":"模型未找到","ref_code":400033}
地址少了 /v1：HTTP 404：404 page not found
地址写错了域名：连不上（状态未知，请勿盲目重发写操作）：<urlopen error ...>
```

记住这四张脸：401 是钥匙不对、400 是模型名或参数不对、404 是路没修到 `/v1`，这三种再试一百次还是错，`_post()` 直接报错停下；只有网络超时、429 限流或 5xx 对面抽风，才按 `1s → 2s → 4s` 退避重试。

![[零基础学AI/attachments/下册第 1 章｜和模型说上话：一封信，一本账/S6X0bOOE4opfyRxFYcCcZO6xnfz.png|分清正常完成、明确失败与结果未知，是工程第一课。]]

---

## 本章实战成品：给《上册》自动写一份总目录

现在把工具拉上战场。`index_kb.py` 会扫描 `零基础学AI/上册/` 里的全部 25 篇 Markdown 笔记，先用 `clean_preview()` 剥掉开头的 `---` YAML 元数据和正文里的 `![[...png]]` / `> 🎬` 多媒体嵌入行，再让模型为每篇写出“一句话摘要 + 三个标签”，拼成一份 `上册知识库目录.md`：

```python
# index_kb.py：第 01 章实战成品——扫描《上册》全部笔记，生成《上册知识库目录.md》
import os
import sys
import llm

DEFAULT_KB = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))
ASK = (
    "下面是一篇技术教程笔记的开头节选。请只输出一行，严格使用以下格式：\n"
    "一句话摘要（不超过30字）｜标签1, 标签2, 标签3\n"
    "不要输出任何多余解释。\n\n"
)


def clean_preview(raw_text, limit=1200):
    """去掉 Obsidian YAML 头信息和图片/视频嵌入行，保留标题与核心正文前段。"""
    lines = raw_text.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1 :]
                break
    kept = []
    for ln in lines:
        s = ln.strip()
        if s.startswith("![[") or s.startswith("> 🎬"):
            continue
        kept.append(ln)
    return "\n".join(kept).strip()[:limit]


def main():
    folder = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KB
    if not os.path.isdir(folder):
        sys.exit(f"找不到目录：{folder}")

    rows, odd = [], []
    md_files = sorted(f for f in os.listdir(folder) if f.endswith(".md") and f != "上册知识库目录.md")
    for name in md_files:
        raw = open(os.path.join(folder, name), encoding="utf-8").read()
        preview = clean_preview(raw)
        title = next((l.lstrip("# ").strip() for l in preview.splitlines() if l.startswith("#")), name[:-3])
        line = llm.chat([{"role": "user", "content": ASK + preview}]).strip().splitlines()[0]
        if line.count("｜") != 1:
            odd.append(f"{name}：{line}")
            continue
        summary, tags = (p.strip() for p in line.split("｜"))
        rows.append(f"| [{title}]({name}) | {summary} | {tags} |")

    out_path = os.path.join(folder, "上册知识库目录.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# 上册知识库目录\n\n| 章节 | 一句话 | 标签 |\n|-|-|-|\n" + "\n".join(rows) + "\n")

    print(f"已生成 {out_path}：收录 {len(rows)} 篇" + (f"，格式不符跳过 {len(odd)} 篇" if odd else ""))
    for o in odd:
        print("  跳过：", o)
    print(llm.bill(price_in=1.0, price_out=4.0))


if __name__ == "__main__":
    main()
```

跑一遍 `python3 课件/ch01/index_kb.py`（如果紧接着再跑第二遍，你会看到 `真实调用 0 次，命中缓存 25 次`，一分钱不花）。

但先别急着庆祝——打开生成的 `上册知识库目录.md`，仔细盯一眼最后一栏的标签：

```markdown
| [第 01 章｜规则总也写不完](第 01 章｜规则总也写不完.md) | 规则写不完的三堵墙与正确分工 | 符号主义, ELIZA, 专家系统 |
| [第 02 章｜给它例子，它就能学会吗？](第 02 章｜给它例子，它就能学会吗？.md) | 从感知机到反向传播与泛化 | 感知机，神经网络，反向传播 |
```

你发现了什么？第一行用的是**英文逗号加空格**，第二行用的是**中文逗号**；而且提示词里只要模型偶尔多嘴写一句“好的，摘要如下：”，就会因为 `line.count("｜") != 1` 整篇被跳过。

人看着没问题，下游程序按标签聚合时却会直接崩溃。**第 02 章**，我们就来治这个毛病：让模型交出严格合规、绝不走样的结构化 JSON 卡片。

---

## 这一章你留下了什么

```text
课件/ch01/
  raw.py         无封装原始 HTTP 调用，怀疑封装出问题时随时回来查它
  llm.py         全册统一入口：Token Plan 接入、流式、SHA-256 缓存、预算保险丝、三分法与账本
  streaming.py   首字等待时间对比实验
  oops.py        401 / 400 / 404 / 超时四张常见报错脸谱
  index_kb.py    清洗头信息与多媒体行，扫描《上册》生成总目录
```

## 改一改

1. 把 `index_kb.py` 里的 `clean_preview(..., limit=1200)` 改成只截取前 200 字，对比一下同一篇《第 01 章》生成的摘要有什么变化，并观察 `llm.bill()` 里的缓存命中情况。
2. 故意把环境变量 `MYKB_MAX_CALLS=3` 设小，再删掉 `.cache/` 重跑 `index_kb.py`，亲眼看一眼 `BudgetExceeded` 保险丝是怎么在第 4 次请求前及时踩住刹车的。
3. 在 `index_kb.py` 里把 `chat` 换成 `stream`，让目录一边生成一边实时打印到终端，算一算此时 `LEDGER` 还能不能准确记下每次调用的 Token 账。
4. 把 `index_kb.py` 末尾的目录路径参数换成你自己电脑里的一个 Obsidian 文件夹（`python3 index_kb.py ~/你的笔记目录`），看看给你自己的抽屉写一页目录花了多少钱。
