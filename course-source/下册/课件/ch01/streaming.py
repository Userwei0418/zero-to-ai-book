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
