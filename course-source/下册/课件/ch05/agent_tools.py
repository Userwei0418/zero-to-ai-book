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
