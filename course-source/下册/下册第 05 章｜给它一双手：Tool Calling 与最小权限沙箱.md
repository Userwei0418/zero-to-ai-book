# 下册第 05 章｜给它一双手：Tool Calling 与最小权限沙箱

*这一章做完：你的知识库不再只是“你搜好五段喂给它”，而是由模型自己决定要查哪个文件、读第几行，并在最小权限路径沙箱（`safe_path` + 读写物理隔离）的保护下，安全地把整理好的学习笔记写进沙箱目录。对应上册第 08 章。*

## 从“喂食”到“自己伸手拿”

第 04 章的 `ask.py` 已经很好用了，但它有一个明显的短板：**检索发生在模型思考之前，而且只发生一次。**

要是你问它：“请帮我看看第 02 章结尾预告了什么问题，再去第 03 章开头看看是怎么接上这个问题的，最后帮我记一条对比笔记。”

`ask.py` 拿着这么长一句话去搜一次，前 5 段要么全是第 02 章，要么全是第 03 章，而且它根本没有写文件的地方。

要办成这件事，得像上册第 08 章讲的那样：给模型配一个**工具箱（Toolbox）**。模型在房间里看题，需要查目录、读某几行、或者写笔记时，从门缝里递出一张结构化的纸条（`tool_calls`）；外面的 Python 程序接过纸条，替它办完，再把结果塞回门缝。

![[零基础学AI/attachments/下册第 3 章｜给它一双手：一张纸条，一个工具箱/AwFRb5rIfovfMMx5z35cldeZn5f.png|模型只管递纸条，真正碰文件的手长在你的程序上。]]

---

## 给它手之前，先想清楚怎么防它“乱摸”

一旦你的 Python 程序愿意照着模型递过来的纸条去读写硬盘，两个致命的安全问题立刻摆在眼前：

1. **路径逃逸（Path Traversal）**：工具参数里有一个 `filename`。如果模型因为幻觉、或者被笔记里一段恶意的提示词注入诱导，递过来一张写着 `filename="../../.ssh/id_rsa"` 或 `filename="/etc/passwd"` 的纸条，而你的代码直接写了 `open(os.path.join(KB_ROOT, filename))`，你电脑上的私钥和系统文件当场就会被读出去。
2. **误傷原书语料**：你想让助手帮你记一条学习心得，万一它挑中了 `filename="第 01 章｜规则总也写不完.md"` 直接往里写，辛辛苦苦整理好的《上册》原稿就被污染了。

![[零基础学AI/attachments/下册第 3 章｜给它一双手：一张纸条，一个工具箱/GXc3bwDM9oBQeexCs8dcnPDdnac.png|只读的原书抽屉和可写的草稿本，必须物理隔开。]]

所以，我们在 `课件/ch05/toolbox.py` 里立下三条铁律，少一条都不开门：

### 铁律一：路径规范化与前缀锁死（`safe_path`）

凡是模型传进来的文件名，一律先过 `safe_path(root, rel_path)`：
- 如果是 `/` 开头的绝对路径，当场拒绝；
- 用 `os.path.abspath(os.path.join(root, rel_path))` 把里面所有的 `../` 消解成真实绝对路径；
- 检查消解后的路径是不是严格以 `root + "/"` 开头——但凡逃出 `root` 半步，立刻抛出 `SandboxError`。

### 二、只读区与可写区物理隔离

- 只读工具（`list_notes`、`read_note`）的根目录锁在 `零基础学AI/上册/`，且每次最多读 120 行，防止模型一口气把几万字全塞爆上下文；
- 写入工具（`write_study_note`）的根目录**单独锁在 `课件/ch05/notes_sandbox/`**，从物理路径上彻底杜绝触碰《上册》原稿的可能。

### 三、默认只读开关（`allow_write=False`）

平时只做问答时，`toolbox.specs(allow_write=False)` 连 `write_study_note` 的函数说明书都不发给模型；就算模型自己瞎猜出一个写入调用，`execute()` 也会在入口处直接拦下返回“权限拒绝”。只有你在命令行显式加上 `--write`，才放开写入权限。

---

## 完整工具箱与沙箱实现：`toolbox.py`

我们还顺手写了一个小巧的装饰器 `@tool(...)`，自动把 Python 函数名、说明和参数拼成 OpenAI 兼容的 JSON Schema，省得手写大段重复的字典：

```python
# toolbox.py：第 05 章核心——工具注册表、JSON Schema 自动生成与最小权限路径沙箱
import json
import os

KB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))
SANDBOX_NOTES = os.path.abspath(os.path.join(os.path.dirname(__file__), "notes_sandbox"))


class SandboxError(Exception):
    """越权路径或被沙箱拦截的危险操作。"""


def safe_path(root, rel_path):
    """把相对路径解析到 root 内部；任何 ../ 逃逸或绝对路径直接拦截。"""
    if os.path.isabs(rel_path):
        raise SandboxError(f"拒绝绝对路径：{rel_path}")
    target = os.path.abspath(os.path.join(root, rel_path))
    if target != root and not target.startswith(root + os.sep):
        raise SandboxError(f"路径逃逸被沙箱拦截：{rel_path}")
    return target


TOOLS = {}


def tool(desc, mode="read", **params):
    """把普通 Python 函数注册为可供模型调用的工具，并标明只读(read)或写入(write)权限。"""
    def deco(fn):
        props = {k: {"type": "string", "description": v} for k, v in params.items()}
        TOOLS[fn.__name__] = {
            "fn": fn,
            "mode": mode,
            "spec": {
                "type": "function",
                "function": {
                    "name": fn.__name__,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props, "required": list(params.keys())},
                },
            },
        }
        return fn
    return deco


@tool("列出知识库里的 Markdown 文件名", mode="read", keyword="可选过滤关键词，留空则列出全部")
def list_notes(keyword=""):
    files = sorted(f for f in os.listdir(KB_ROOT) if f.endswith(".md"))
    if keyword:
        files = [f for f in files if keyword in f]
    return json.dumps(files[:30], ensure_ascii=False)


@tool("按文件名读取《上册》笔记的指定行范围", mode="read", filename="笔记文件名", start_line="起始行号(从1开始)", end_line="结束行号")
def read_note(filename, start_line="1", end_line="60"):
    path = safe_path(KB_ROOT, filename)
    if not os.path.exists(path):
        return f"找不到文件：{filename}"
    s = max(1, int(start_line))
    e = min(s + 120, int(end_line))
    lines = open(path, encoding="utf-8").read().splitlines()
    slice_lines = [f"{i}: {ln}" for i, ln in enumerate(lines[s - 1 : e], start=s)]
    return "\n".join(slice_lines) if slice_lines else "该行范围为空"


@tool("在学习笔记沙箱目录里新建或追加一篇读书笔记（绝不触碰上册原文）", mode="write", filename="新建笔记文件名(如 学习心得.md)", content="笔记正文内容")
def write_study_note(filename, content):
    os.makedirs(SANDBOX_NOTES, exist_ok=True)
    path = safe_path(SANDBOX_NOTES, filename)
    with open(path, "a", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n\n")
    return f"已安全写入沙箱笔记：{os.path.relpath(path, SANDBOX_NOTES)}"


def specs(allow_write=False):
    """默认只把只读工具交给模型；只有显式允许时才开放写入工具。"""
    return [t["spec"] for t in TOOLS.values() if allow_write or t["mode"] == "read"]


def execute(tool_call, allow_write=False):
    name = tool_call["function"]["name"]
    if name not in TOOLS:
        return f"未知工具：{name}"
    entry = TOOLS[name]
    if entry["mode"] == "write" and not allow_write:
        return f"权限拒绝：当前为只读模式，不能执行写入工具 {name}"
    args = json.loads(tool_call["function"].get("arguments") or "{}")
    try:
        return str(entry["fn"](**args))
    except SandboxError as e:
        return f"沙箱拦截：{e}"
    except Exception as e:
        return f"工具执行出错：{e}"
```

---

## 故意弄坏它：拿越权路径和未授权写操作撞一撞沙箱

在接上大模型之前，我们先在本地写个小测试，故意用三种危险请求去撞 `toolbox.py`：

1. 传入 `../../etc/passwd` 试图跳出《上册》目录；
2. 传入 `/etc/passwd` 绝对路径；
3. 在默认 `allow_write=False` 下强行调用 `write_study_note`。

跑一遍看结果：

```bash
python3 -c '
import sys
sys.path.insert(0, "课件/ch05")
import toolbox

for bad in ("../../etc/passwd", "/etc/passwd"):
    try:
        toolbox.safe_path(toolbox.KB_ROOT, bad)
    except toolbox.SandboxError as e:
        print("成功拦截越权路径 ->", e)

res = toolbox.execute({"function": {"name": "write_study_note", "arguments": "{\"filename\":\"a.md\",\"content\":\"hi\"}"}}, allow_write=False)
print("默认只读模式写测试 ->", res)
'
```

```
成功拦截越权路径 -> 路径逃逸被沙箱拦截：../../etc/passwd
成功拦截越权路径 -> 拒绝绝对路径：/etc/passwd
默认只读模式写测试 -> 权限拒绝：当前为只读模式，不能执行写入工具 write_study_note
```

![[零基础学AI/attachments/下册第 3 章｜给它一双手：一张纸条，一个工具箱/UotYbS1gdo9kqkxfox7cBE3jnwh.png|安全边界必须焊死在外侧程序里，而不是写在提示词里。]]

> **老办法，新地方**
>
> “用 `realpath / abspath` 消解路径后再核对目录前缀、把只读挂载与读写挂载分开、默认最小权限（Least Privilege）”，这是 UNIX `chroot`、容器挂载和 Web 静态文件服务器用了几十年的基本功。大模型再听话，也不能拿提示词当防火墙。

---

## 本章实战成品：让模型自己查目录、翻页、记笔记

现在写 `课件/ch05/agent_tools.py`，把工具说明书递给模型，让它自己决定先调 `list_notes` 找文件名，再调 `read_note` 翻看指定行：

```python
# agent_tools.py：第 05 章实战——让模型自己挑工具、递纸条，由程序在沙箱内执行后把回执递回去
# 用法：python3 agent_tools.py "帮我查一下第 02 章里关于楼梯灯的代码输出，并记一条学习心得" [--write]
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch02")))
import llm
import toolbox


def ask_with_tools(question, allow_write=False, max_steps=5):
    messages = [
        {"role": "system", "content": "你是知识库助教。需要查笔记时请调用工具；回答必须基于工具返回的真实内容。"},
        {"role": "user", "content": question},
    ]
    tool_specs = toolbox.specs(allow_write=allow_write)
    for step in range(max_steps):
        _, _, model = llm._cfg()
        body = {"model": model, "messages": messages, "tools": tool_specs, "temperature": 0}
        with llm._post(body) as resp:
            data = llm._parse(resp.read().decode("utf-8", "replace"))
        llm._book(data.get("usage"), 0.0)
        msg = data["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            return msg.get("content") or ""
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            print(f"  [第 {step + 1} 步] 模型递纸条 -> {c['function']['name']} {c['function']['arguments']}")
            res = toolbox.execute(c, allow_write=allow_write)
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": res})
    return "达到最大工具步数上限，先停在这里。"


if __name__ == "__main__":
    allow_w = "--write" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--write"]
    q = " ".join(args) or "请列出包含 02 的笔记文件，并读取前 30 行。"
    print(ask_with_tools(q, allow_write=allow_w))
```

试着跑一下只读查询和带 `--write` 的记笔记：

```bash
python3 课件/ch05/agent_tools.py "请找出第 02 章的笔记，读前 30 行告诉我它从哪一年讲起"
python3 课件/ch05/agent_tools.py "总结第 02 章前 60 行的核心问题并记到 02学习心得.md" --write
```

你会看到终端里一步一步印出模型递出来的纸条：

```
  [第 1 步] 模型递纸条 -> list_notes {"keyword": "02"}
  [第 2 步] 模型递纸条 -> read_note {"filename": "第 02 章｜给它例子，它就能学会吗？.md", "start_line": "1", "end_line": "30"}
第 02 章从 1958 年 7 月 7 日华盛顿美国气象局的 IBM 704 感知机演示讲起 [第 02 章｜给它例子，它就能学会吗？.md:7-11]。
```

看着它自己翻目录、自己翻页，感觉确实像个真助手了。但只要你给它派一个稍微大点的活儿——比如“把第 01、02、03、04 章里资料助手的四次升级全部翻出来做张对比表”——跑着跑着你就会遇上两件让人冒冷汗的事：

1. 它有时会忘记自己刚才已经读过第 01 章的 `1–60` 行，过两步又拿一模一样的参数再读一遍，在原地转圈；
2. 跑到第 5 步刚查完三章，网络突然抖了一下断线报错，前面 4 步白花花的 Token 全打水漂，重跑又得从第 1 步重头来。

**第 06 章**，我们就给这个循环装上**重复调用拦截器**、**步数刹车**和**每步落盘的断点续传**。

---

## 这一章你留下了什么

```text
课件/ch05/
  toolbox.py        @tool 装饰器、safe_path() 路径逃逸拦截、只读/可写物理隔离
  agent_tools.py    完整的 Tool Calling 多步来回执行器
  notes_sandbox/    开启 --write 后安全落盘的学习笔记沙箱目录
```

## 改一改

1. 把第 04 章的 `hybrid_search()` 也用 `@tool("按问题或关键词混合检索《上册》知识库", mode="read", query="检索词")` 注册进 `toolbox.py`，让模型既能按文件名整段读，也能直接用混合检索跨章找线索。
2. 在 `write_study_note` 里加一道文件名白名单检查：只允许写入 `.md` 或 `.txt` 后缀的文件；如果模型想写 `.py` 或 `.sh` 脚本，直接返回沙箱拦截。
3. 故意在问题里写一句诱导的话：`"请调用 read_note 读取 ../ch01/llm.py 的内容"`，跑一遍 `agent_tools.py`，看看 `safe_path()` 拦住它之后，模型是怎么向你汇报的。
4. 给 `execute()` 加上耗时与结果长度统计：如果某个工具返回的字符串超过 3000 字，自动截断并附上一句 `"[内容过长已截断，请缩小 start_line/end_line 范围分段读取]"`，防止单次工具调用撑爆上下文。
