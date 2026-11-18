# 下册第 07 章｜接进日常工具：把知识库做成标准 MCP 服务

*这一章做完：你用不到一百行纯 Python 标准库，把《上册》混合检索引擎与沙箱工具封装成一个标准的 **MCP（Model Context Protocol）** 服务端 `mcp_server.py`，并用 `mcp_client_demo.py` 走通完整的子进程握手、列工具与真实检索联调。不写一行特定软件的私有插件代码，直接插进 Claude Code、Cursor 等日常助手就能用。对应上册第 10 章。*

## 为什么不要给每个助手各写一套插件？

前六章做下来，你的知识库已经相当能干了：有 746 块《上册》语料，有 BM25 + 向量混合检索，有 `list_notes` 和 `read_note` 沙箱工具。

可你平时工作的时候，不会总想专门切到一个黑乎乎的终端里跑 `python3 ask.py`。你每天打开的是 Claude Code、Cursor、WorkBuddy 或者别家的 IDE 助手。你真正想要的是：**在那些你已经用顺手的助手里聊着天，它能直接翻你的《上册》知识库。**

如果每家助手都自己定一套插件格式，你今天给 A 写一个适配器、明天给 B 写一个适配器，光跟在后面改接口就累死了。

上册第 10 章讲过，**MCP（Model Context Protocol）** 解决的就是这个“N 乘 M 重新接线”的麻烦——它就像电脑上的 USB-C 接口：你的知识库只需要实现一次标准的 MCP 服务端，任何支持 MCP 的客户端插上就能认出你的工具。

![[零基础学AI/attachments/下册第 4 章｜接进你每天用的助手：一套说法，到处能接/EjSvbbJOzooeShxzCikcL2U2n9l.png|约好一套标准的插头，外面的助手随便换，里面的知识库一行不用改。]]

---

## 掀开盖子看：MCP 其实就是三步 JSON-RPC 对话

很多人一听“协议”就觉得要装一堆庞大的 SDK。其实本地 MCP 服务最常用的 **stdio（标准输入输出）模式**，掀开盖子简单得惊人：

客户端（比如 Claude Code）把你的 `mcp_server.py` 当成一个后台子进程启动；客户端往你的 `sys.stdin` 写一行 JSON，你处理完往 `sys.stdout` 回一行 JSON（遵循 JSON-RPC 2.0 格式）。

从头到尾只需要对上三句暗号：

1. **第一句暗号 `initialize`（握手）**：客户端问“你支持什么协议版本、有什么本事？”你回“协议版本 `2025-06-18`，我叫 `mykb-mcp`，我有 `tools`（工具）本事。”紧接着客户端发一行通知 `notifications/initialized`（没有 `id`，不用回话），握手完成。
2. **第二句暗号 `tools/list`（亮家当）**：客户端问“你手头有哪几件工具？”你把 `kb_search`、`kb_list_notes`、`kb_read_note` 的名字、说明和参数 Schema 列表交出去。
3. **第三句暗号 `tools/call`（真干活）**：客户端点名“请调 `kb_search`，参数是 `{"query": "第 07 章 一刀切"}`”，你内部直接调第 04 章写好的 `search.hybrid_search()`，把查出来的段落包进 `{"content": [{"type": "text", "text": "..."}]}` 递回去。

![[零基础学AI/attachments/下册第 4 章｜接进你每天用的助手：一套说法，到处能接/TXnGbSn3sorZyfxmLpQccQs5nGc.png|三次握手与问答：先报家门，再交清单，最后按名调用。]]

---

## 实跑踩出的一个真坑：`for raw in sys.stdin` 为什么会卡死？

写第一版 `mcp_server.py` 时，很多人会顺手写下：

```python
for raw in sys.stdin:
    ...
```

在终端里手动敲字测试好好的，可一旦用 `subprocess.Popen` 让客户端子进程通过管道连上来，**客户端发完第一条 `initialize` 请求后，两边就永远卡死在那里，谁也不动了！**

这是我们在实跑联调时亲手踩到的一个经典 Python 管道坑：当 `sys.stdin` 连着操作系统的管道（Pipe）而不是真终端（TTY）时，Python 的文件迭代器 `for line in sys.stdin:` 为了省系统调用，会在内部攒够一大块缓冲区（比如 4KB 或 8KB）或者等管道关闭（EOF）才肯吐出第一行。而 JSON-RPC 是你一句我一句的短报文，客户端发完一百字节就停下来等回执，服务端却还在傻等凑齐 4KB，当场死锁。

修复办法只有两点，但缺一不可：
1. **读的时候用 `sys.stdin.readline()`**，读到换行符 `\n` 立刻返回，绝不攒块缓冲；
2. **写完回执后立刻 `sys.stdout.flush()`**，把响应当场推过管道。

下面是修复后的完整 `课件/ch07/mcp_server.py`：

```python
# mcp_server.py：第 07 章实战成品——零第三方依赖的标准 MCP（JSON-RPC 2.0 over stdio）知识库服务
# 可直接配置进 Claude Code / Cursor / 任意支持 MCP stdio 的客户端
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch04")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch05")))
import search
import toolbox

SERVER_INFO = {"name": "mykb-mcp", "version": "0.1.0"}
PROTOCOL_VERSION = "2025-06-18"

MCP_TOOLS = [
    {
        "name": "kb_search",
        "description": "用 BM25 + 向量混合检索搜索《上册》知识库，返回带行号出处的最相关段落",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要检索的问题或关键词"},
                "top_k": {"type": "integer", "description": "返回条数，默认 5"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "kb_list_notes",
        "description": "列出知识库里的 Markdown 笔记文件名",
        "inputSchema": {
            "type": "object",
            "properties": {"keyword": {"type": "string", "description": "可选过滤关键词"}},
        },
    },
    {
        "name": "kb_read_note",
        "description": "按文件名与行号范围读取笔记原文",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "笔记文件名"},
                "start_line": {"type": "integer", "description": "起始行号"},
                "end_line": {"type": "integer", "description": "结束行号"},
            },
            "required": ["filename"],
        },
    },
]


def handle_call(name, args):
    if name == "kb_search":
        hits, modes = search.hybrid_search(args["query"], top_k=int(args.get("top_k", 5)))
        lines = [f"检索通道：{modes}"]
        for i, h in enumerate(hits, start=1):
            lines.append(f"[{i}] {h['source']}:{h['start_line']}-{h['end_line']}\n{h['text']}")
        return "\n\n".join(lines)
    if name == "kb_list_notes":
        return toolbox.list_notes(args.get("keyword", ""))
    if name == "kb_read_note":
        return toolbox.read_note(args["filename"], str(args.get("start_line", 1)), str(args.get("end_line", 60)))
    raise ValueError(f"未知工具：{name}")


def serve():
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break
        line = raw.strip()
        if not line:
            continue
        req = json.loads(line)
        method = req.get("method")
        req_id = req.get("id")
        if req_id is None:
            continue  # notification（如 notifications/initialized）无需回包

        try:
            if method == "initialize":
                result = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                }
            elif method == "tools/list":
                result = {"tools": MCP_TOOLS}
            elif method == "tools/call":
                p = req.get("params") or {}
                text = handle_call(p["name"], p.get("arguments") or {})
                result = {"content": [{"type": "text", "text": text}]}
            else:
                raise ValueError(f"不支持的方法：{method}")
            resp = {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as e:
            resp = {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": str(e)}}

        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    serve()
```

---

## 写一个客户端子进程把全链路验通：`mcp_client_demo.py`

“写了服务端代码”不等于“能被外部客户端调通”。我们写一个 40 行的 `mcp_client_demo.py`，像 Claude Code 一样用 `subprocess.Popen` 拉起 `mcp_server.py`，真刀真枪走完握手、列工具和 `kb_search` 调用：

```python
# mcp_client_demo.py：第 07 章验证脚本——以子进程启动 mcp_server.py，走完标准 MCP 握手、列工具与真实检索调用
import json
import os
import subprocess
import sys

SERVER = os.path.join(os.path.dirname(__file__), "mcp_server.py")


def rpc(proc, req_id, method, params=None):
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def main():
    proc = subprocess.Popen(
        [sys.executable, SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        init = rpc(proc, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "demo", "version": "0.1"}})
        print("1. 握手成功：", init["result"]["serverInfo"])
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()

        tools = rpc(proc, 2, "tools/list", {})
        print("2. 暴露工具：", [t["name"] for t in tools["result"]["tools"]])

        call_res = rpc(proc, 3, "tools/call", {"name": "kb_search", "arguments": {"query": "第 07 章 一刀切", "top_k": 2}})
        print("3. kb_search 返回前 220 字：\n" + call_res["result"]["content"][0]["text"][:220] + "…")
    finally:
        proc.stdin.close()
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    main()
```

跑一遍 `python3 课件/ch07/mcp_client_demo.py`，三步一气呵成：

```
1. 握手成功： {'name': 'mykb-mcp', 'version': '0.1.0'}
2. 暴露工具： ['kb_search', 'kb_list_notes', 'kb_read_note']
3. kb_search 返回前 220 字：
检索通道：{'vector': 'Local-Bigram-Cosine', 'rerank': 'Local-Heuristic-Rerank'}

[1] 第 07 章｜它很聪明，却不知道我们的事.md:1-4
# 第 07 章｜它很聪明，却不知道我们的事

*第三篇　开始做事*

[2] 第 04 章（下）｜读遍互联网之后：MiniMind 预训练与上下文学习.md:192-198
4. 如果你想把部门最新的《实习生审批规定》教给…
```

现在，只要在你电脑上的 Claude Code 或 Cursor 配置文件里加上这几行，你的日常编程助手就立刻拥有了查阅整本《上册》（或你自己的 Obsidian 库）的能力：

```json
{
  "mcpServers": {
    "mykb": {
      "command": "python3",
      "args": ["/你的绝对路径/零基础学AI/下册/课件/ch07/mcp_server.py"]
    }
  }
}
```

> **老办法，新地方**
>
> “把核心业务包成独立进程，用标准输入输出或标准套接字讲公开协议，谁都能来连”，这和 UNIX 管道、LSP（语言服务器协议，让一个代码补全后端接进 VS Code / Vim / Emacs 所有编辑器）完全是同一个路数。

工具接通了，下一个问题马上来了：你有好几种固定套路的工作流（比如“按三段式模板整理学习卡片”“精确统计全库字数与视频数”“生成本周学习周报”）。如果把所有套路的详细说明全塞进开场白，每次闲聊一句都要先读几千字规矩。**第 08 章**，我们用三层渐进式 **Skill 引擎**解决它。

---

## 这一章你留下了什么

```text
课件/ch07/
  mcp_server.py        零第三方依赖的标准 MCP stdio 知识库服务
  mcp_client_demo.py   子进程握手、列工具与真实检索的全链路联调脚本
```

## 改一改

1. 注意 detail：在 stdio 模式下，`sys.stdout` 是专门留给 JSON-RPC 报文走的专用车道。如果你在 `handle_call()` 里顺手写了一句 `print("正在搜索...")`，客户端解析 JSON 时会发生什么？试着把所有调试日志改写到 `sys.stderr.write()`。
2. 给 `MCP_TOOLS` 再加第 4 个工具 `kb_cards`：按主题（如 `"机器学习基础"`）读取第 02 章生成的 `cards.jsonl`，返回该主题下所有章节的卡片摘要。
3. 故意在 `mcp_client_demo.py` 里调用一个不存在的工具名 `"kb_delete_all"`，看看 `mcp_server.py` 返回的 JSON-RPC `error` 字段长什么样。
4. 把 `mcp_server.py` 真正配进你电脑上的 Claude Code 或 Cursor，在聊天框里问一句：“请用 `mykb` 的 `kb_search` 查一下第 03 章里迷宫加金币为什么撞了 46 下墙？”
