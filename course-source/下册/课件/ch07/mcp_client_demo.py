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
