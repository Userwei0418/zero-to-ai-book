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
