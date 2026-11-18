# loop.py：第 06 章实战成品——带断点续传、重复调用检测与步数刹车的自主执行循环
# 用法：python3 loop.py task01 "对比第 01、02、03 章资料助手演进，写一份三点总结"
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch02")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch05")))
import llm
import toolbox

CKPT_DIR = os.path.join(os.path.dirname(__file__), "checkpoints")


def _ckpt_path(task_id):
    os.makedirs(CKPT_DIR, exist_ok=True)
    return os.path.join(CKPT_DIR, f"{task_id}.json")


def save_ckpt(task_id, state):
    with open(_ckpt_path(task_id), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def load_ckpt(task_id):
    p = _ckpt_path(task_id)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None


def run_task(task_id, goal, max_steps=8, allow_write=False):
    state = load_ckpt(task_id)
    if state and state.get("status") == "done":
        print(f"[{task_id}] 任务已完成（从断点直接返回结果）")
        return state["answer"]

    if state:
        print(f"[{task_id}] 检测到未完成断点，从第 {state['step'] + 1} 步继续执行…")
    else:
        state = {
            "task_id": task_id,
            "goal": goal,
            "step": 0,
            "status": "running",
            "seen_calls": [],
            "messages": [
                {
                    "role": "system",
                    "content": "你是严谨的知识库助手。请分步调用工具查证《上册》原文后回答，每条结论附 [文件名:行号]；不要重复调用完全相同的工具参数。",
                },
                {"role": "user", "content": goal},
            ],
            "answer": "",
        }
        save_ckpt(task_id, state)

    specs = toolbox.specs(allow_write=allow_write)
    while state["step"] < max_steps:
        state["step"] += 1
        _, _, model = llm._cfg()
        body = {"model": model, "messages": state["messages"], "tools": specs, "temperature": 0}
        with llm._post(body) as resp:
            data = llm._parse(resp.read().decode("utf-8", "replace"))
        llm._book(data.get("usage"), 0.0)
        msg = data["choices"][0]["message"]
        calls = msg.get("tool_calls") or []

        if not calls:
            state["status"] = "done"
            state["answer"] = msg.get("content") or ""
            save_ckpt(task_id, state)
            return state["answer"]

        state["messages"].append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            sig = f"{c['function']['name']}::{c['function'].get('arguments', '')}"
            if sig in state["seen_calls"]:
                res = "提示：你此前已经用完全相同的参数调用过该工具，请勿原地打转；请换检索词或直接根据已有信息作答。"
            else:
                state["seen_calls"].append(sig)
                res = toolbox.execute(c, allow_write=allow_write)
            state["messages"].append({"role": "tool", "tool_call_id": c["id"], "content": res})
        save_ckpt(task_id, state)

    state["status"] = "stopped_max_steps"
    state["answer"] = f"已达最大步数刹车上限（{max_steps} 步），当前进度已保存至断点 {task_id}.json。"
    save_ckpt(task_id, state)
    return state["answer"]


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else "demo_task"
    q = " ".join(sys.argv[2:]) or "请分别查阅第 01、02、03 章，总结资料助手 v0.1 到 v0.3 的演进。"
    print(run_task(tid, q))
