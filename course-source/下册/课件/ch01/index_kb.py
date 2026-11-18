# index_kb.py：第 01 章实战成品——扫描《上册》全部笔记，清洗头信息与多媒体行后生成一份《上册知识库目录.md》
# 用法：python3 index_kb.py [笔记目录，默认指向 ../../../上册]
import os
import re
import sys
import llm

DEFAULT_KB = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))
ASK = (
    "下面是一篇技术教程笔记的开头节选。请只输出一行，严格使用以下格式：\n"
    "一句话摘要（不超过30字）｜标签1, 标签2, 标签3\n"
    "不要输出任何多余解释。\n\n"
)


def clean_preview(raw_text, limit=1200):
    """去掉 Obsidian YAML 头信息和图片/视频嵌入行，保留标题与核心正文前段。"""
    lines = raw_text.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1 :]
                break
    kept = []
    for ln in lines:
        s = ln.strip()
        if s.startswith("![[") or s.startswith("> 🎬"):
            continue
        kept.append(ln)
    return "\n".join(kept).strip()[:limit]


def main():
    folder = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KB
    if not os.path.isdir(folder):
        sys.exit(f"找不到目录：{folder}")

    rows, odd = [], []
    md_files = sorted(f for f in os.listdir(folder) if f.endswith(".md") and f != "上册知识库目录.md")
    for name in md_files:
        raw = open(os.path.join(folder, name), encoding="utf-8").read()
        preview = clean_preview(raw)
        title = next((l.lstrip("# ").strip() for l in preview.splitlines() if l.startswith("#")), name[:-3])
        line = llm.chat([{"role": "user", "content": ASK + preview}]).strip().splitlines()[0]
        if line.count("｜") != 1:
            odd.append(f"{name}：{line}")
            continue
        summary, tags = (p.strip() for p in line.split("｜"))
        rows.append(f"| [{title}]({name}) | {summary} | {tags} |")

    out_path = os.path.join(folder, "上册知识库目录.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# 上册知识库目录\n\n| 章节 | 一句话 | 标签 |\n|-|-|-|\n" + "\n".join(rows) + "\n")

    print(f"已生成 {out_path}：收录 {len(rows)} 篇" + (f"，格式不符跳过 {len(odd)} 篇" if odd else ""))
    for o in odd:
        print("  跳过：", o)
    print(llm.bill(price_in=1.0, price_out=4.0))


if __name__ == "__main__":
    main()
