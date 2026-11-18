# eval.py：第 11 章实战成品——自动化回归评测（Hit@3 召回率 + MRR 平均倒数排名）
# 用法：python3 eval.py
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch04")))
import search

EVAL_PATH = os.path.join(os.path.dirname(__file__), "eval_set.json")


def run_eval():
    cases = json.load(open(EVAL_PATH, encoding="utf-8"))
    docs = search.load_chunks()
    hit3, mrr_sum = 0, 0.0

    for c in cases:
        hits, modes = search.hybrid_search(c["question"], docs=docs, top_k=3)
        sources = [h["source"] for h in hits]
        rank = next((i + 1 for i, s in enumerate(sources) if c["expected_file"] in s), 0)
        if rank > 0:
            hit3 += 1
            mrr_sum += 1.0 / rank
        mark = "✓" if rank > 0 else "✗"
        print(f"{mark} [{c['id']}] rank={rank or '-'} | 期望={c['expected_file']} | 实际Top1={sources[0] if sources else '无'}")

    n = len(cases)
    print(f"\n回归评测汇总：Hit@3 = {hit3}/{n} ({hit3 / n:.1%}), MRR = {mrr_sum / n:.3f}, 通道 = {modes}")


if __name__ == "__main__":
    run_eval()
