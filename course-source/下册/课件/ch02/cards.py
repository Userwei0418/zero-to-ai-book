# cards.py：第 02 章实战成品——批量把《上册》笔记提炼成严格 Schema 的结构化知识卡片（JSONL + 词表对齐）
# 用法：python3 cards.py [笔记目录，默认指向 ../../../上册]
import json
import os
import sys
import llm

DEFAULT_KB = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))
ALLOWED_TOPICS = ["导论与总览", "机器学习基础", "大语言模型", "检索与RAG", "Agent与工具", "记忆与协作", "工程交付"]

PROMPT = f"""请阅读下面这篇《从零开始学 AI》笔记节选，严格输出一个 JSON 对象，包含且仅包含以下 5 个字段：
- "title": 字符串，章节标题
- "topic": 字符串，必须从这个词表里选一个：{json.dumps(ALLOWED_TOPICS, ensure_ascii=False)}
- "core_question": 字符串，这一章解决的核心问题（不超过 30 字）
- "takeaways": 字符串数组，2 到 3 条核心结论，每条不超过 35 字
- "terms": 字符串数组，2 到 4 个关键术语

笔记内容：
"""


def validate_card(obj):
    if not isinstance(obj, dict):
        raise llm.SchemaError("顶层必须是 JSON 对象")
    required = ("title", "topic", "core_question", "takeaways", "terms")
    for k in required:
        if k not in obj:
            raise llm.SchemaError(f"缺少必填字段：{k}")
    if obj["topic"] not in ALLOWED_TOPICS:
        raise llm.SchemaError(f"topic={obj['topic']!r} 不在允许词表 {ALLOWED_TOPICS} 中")
    if not isinstance(obj["takeaways"], list) or not (2 <= len(obj["takeaways"]) <= 3):
        raise llm.SchemaError("takeaways 必须是包含 2–3 条字符串的数组")
    if not isinstance(obj["terms"], list) or not (1 <= len(obj["terms"]) <= 5):
        raise llm.SchemaError("terms 必须是包含 1–5 个术语的数组")
    return obj


def clean_preview(raw_text, limit=1800):
    lines = raw_text.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1 :]
                break
    kept = [ln for ln in lines if not ln.strip().startswith(("![[", "> 🎬"))]
    return "\n".join(kept).strip()[:limit]


def main():
    folder = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KB
    out_path = os.path.join(os.path.dirname(__file__), "cards.jsonl")
    md_files = sorted(f for f in os.listdir(folder) if f.endswith(".md") and f != "上册知识库目录.md")

    cards, failed = [], []
    for name in md_files:
        preview = clean_preview(open(os.path.join(folder, name), encoding="utf-8").read())
        try:
            card = llm.ask_json(PROMPT + preview, validator=validate_card)
            card["file"] = name
            cards.append(card)
        except llm.LLMError as e:
            failed.append((name, str(e)))

    with open(out_path, "w", encoding="utf-8") as f:
        for c in cards:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print(f"生成完成：{len(cards)} 张卡片写入 {out_path}，失败 {len(failed)} 篇")
    for name, err in failed:
        print(f"  失败 {name}：{err}")
    print(llm.bill(price_in=1.0, price_out=4.0))


if __name__ == "__main__":
    main()
