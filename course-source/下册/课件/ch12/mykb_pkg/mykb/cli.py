# cli.py：mykb 统一命令行入口，串联全书第 01–11 章能力
# 用法：
#   mykb ingest [目录]
#   mykb search "你的问题"
#   mykb ask "你的问题"
#   mykb stats [目录]
#   mykb eval
#   mykb mcp
import json
import os
import sys

COURSE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
for sub in ("ch01", "ch03", "ch04", "ch07", "ch08", "ch11"):
    p = os.path.join(COURSE_ROOT, sub)
    if p not in sys.path:
        sys.path.insert(0, p)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print("用法：mykb <ingest|search|ask|stats|eval|mcp> [参数]")
        return 0

    cmd, rest = args[0], args[1:]
    if cmd == "ingest":
        import ingest
        target = os.path.abspath(rest[0]) if rest else ingest.DEFAULT_KB
        chunks = ingest.ingest_folder(target)
        with open(os.path.join(COURSE_ROOT, "ch03/chunks.jsonl"), "w", encoding="utf-8") as f:
            for c in chunks:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
        print(f"已完成解析切块：共 {len(chunks)} 块（目标：{target}）")
    elif cmd == "search":
        import search
        q = " ".join(rest) or "感知机为什么卡在楼梯灯？"
        hits, modes = search.hybrid_search(q, top_k=3)
        print(f"通道：{modes}")
        for i, h in enumerate(hits, start=1):
            print(f"[{i}] {h['source']}:{h['start_line']}-{h['end_line']} (score={h['score']})")
    elif cmd == "ask":
        import ask
        q = " ".join(rest) or "感知机为什么卡在楼梯灯？"
        reply, _, modes = ask.answer(q)
        print(f"通道：{modes}\n\n{reply}")
    elif cmd == "stats":
        import skills
        print(skills.run_skill_script("kb-stats", "count_kb.py", *rest))
    elif cmd == "eval":
        import eval as ev
        ev.run_eval()
    elif cmd == "mcp":
        import mcp_server
        mcp_server.serve()
    else:
        print(f"未知子命令：{cmd}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
