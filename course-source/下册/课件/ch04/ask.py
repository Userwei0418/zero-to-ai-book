# ask.py：第 04 章实战成品——把《上册》746 块语料接进混合检索，带 [文件名:行号] 严格溯源问答
# 用法：python3 ask.py "你的问题"
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch01")))
import llm
from search import hybrid_search

SYSTEM = (
    "你是《从零开始学 AI》知识库助教。请严格只根据下面给出的【参考摘录】回答用户问题。\n"
    "要求：\n"
    "1. 每一条核心结论后面必须附上出处，格式为 [文件名:起始行-结束行]。\n"
    "2. 如果摘录里没有答案，直接回答“知识库里没有查到相关依据”，绝不编造。\n"
)


def answer(question, top_k=5):
    hits, modes = hybrid_search(question, top_k=top_k)
    if not hits:
        return "知识库里没有查到任何相关摘录。", hits, modes

    context = "\n\n".join(
        f"【摘录 {i}｜{h['source']}:{h['start_line']}-{h['end_line']}】\n{h['text']}"
        for i, h in enumerate(hits, start=1)
    )
    reply = llm.chat([
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"【参考摘录】\n{context}\n\n【问题】\n{question}"},
    ])
    return reply, hits, modes


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "第 02 章里感知机为什么卡在楼梯灯？"
    reply, hits, modes = answer(q)
    print(f"检索通道：{modes}\n")
    print(reply)
    print("\n" + llm.bill())
