# memory.py：第 09 章实战成品——L0 流水账 → L1 原子记忆（不可变版本谱系）→ L2/L3 分层归纳与来源回查
# 参考企业级记忆引擎架构：绝不原地覆盖旧记忆，修订必须留版本与来源锚点，支持按预算召回与 L0 原话溯源
import json
import os
import time
import uuid

MEM_DIR = os.path.join(os.path.dirname(__file__), "mem_store")
L0_PATH = os.path.join(MEM_DIR, "l0_events.jsonl")
L1_PATH = os.path.join(MEM_DIR, "l1_atoms.jsonl")
L2_PATH = os.path.join(MEM_DIR, "l2_topics.json")
L3_PATH = os.path.join(MEM_DIR, "l3_profile.md")


def _ensure():
    os.makedirs(MEM_DIR, exist_ok=True)


def _next_event_id():
    if not os.path.exists(L0_PATH):
        return "E-0001"
    with open(L0_PATH, encoding="utf-8") as f:
        n = sum(1 for line in f if line.strip())
    return f"E-{n + 1:04d}"


def record_l0(session_id, role, text, day=None):
    """L0 原始流水账：只追加不修改，程序自动采集（不靠模型自觉）。"""
    _ensure()
    eid = _next_event_id()
    ev = {
        "event_id": eid,
        "session_id": session_id,
        "role": role,
        "day": day or time.strftime("%Y-%m-%d"),
        "text": text,
    }
    with open(L0_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return ev


def read_events(event_ids):
    """顺着锚点（如 ['E-0003']）回查 L0 原始对话原话，补齐可追溯链路。"""
    if not os.path.exists(L0_PATH):
        return []
    wanted = set(event_ids)
    out = []
    with open(L0_PATH, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ev = json.loads(line)
            if ev["event_id"] in wanted:
                out.append(ev)
    return out


def _load_l1():
    if not os.path.exists(L1_PATH):
        return []
    with open(L1_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def publish_l1(topic, key, fact, source_events):
    """L1 原子记忆发布：若同一 (topic, key) 已有 active 版本，不原地覆盖，而是将旧版标为 superseded 并递增版本号。"""
    _ensure()
    atoms = _load_l1()
    prev_ver = 0
    prev_id = None
    for a in atoms:
        if a["topic"] == topic and a["key"] == key and a["status"] == "active":
            a["status"] = "superseded"
            prev_ver = a["version"]
            prev_id = a["atom_id"]

    new_atom = {
        "atom_id": f"A-{uuid.uuid4().hex[:8]}",
        "topic": topic,
        "key": key,
        "version": prev_ver + 1,
        "status": "active",
        "supersedes": prev_id,
        "fact": fact,
        "source_events": list(source_events),
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    atoms.append(new_atom)
    with open(L1_PATH, "w", encoding="utf-8") as f:
        for a in atoms:
            f.write(json.dumps(a, ensure_ascii=False) + "\n")
    rebuild_l2_l3(atoms)
    return new_atom


def rebuild_l2_l3(atoms=None):
    """L2 场景聚合 & L3 核心画像归纳：只基于 active 版本的 L1 原子记忆投影生成。"""
    _ensure()
    atoms = atoms if atoms is not None else _load_l1()
    active = [a for a in atoms if a["status"] == "active"]
    by_topic = {}
    for a in active:
        by_topic.setdefault(a["topic"], []).append(
            f"- [{a['key']} v{a['version']}] {a['fact']} (来源: {','.join(a['source_events'])})"
        )
    with open(L2_PATH, "w", encoding="utf-8") as f:
        json.dump(by_topic, f, ensure_ascii=False, indent=2)

    profile_lines = ["# 核心记忆画像 (L3)", ""]
    for topic, items in sorted(by_topic.items()):
        profile_lines.append(f"## {topic}")
        profile_lines.extend(items[:3])
        profile_lines.append("")
    with open(L3_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(profile_lines))


def recall(query="", budget_chars=800):
    """按 L3 -> L2 -> L1 优先级在字符预算内装配上下文，绝不把过时(superseded)记忆混进提示词。"""
    parts = []
    if os.path.exists(L3_PATH):
        parts.append(open(L3_PATH, encoding="utf-8").read().strip())
    if query and os.path.exists(L2_PATH):
        l2 = json.load(open(L2_PATH, encoding="utf-8"))
        for topic, items in l2.items():
            if any(w in topic or w in "\n".join(items) for w in query.split()):
                parts.append(f"### 场景记忆：{topic}\n" + "\n".join(items))
    joined = "\n\n".join(parts)
    return joined[:budget_chars]


if __name__ == "__main__":
    # 演示完整 L0 -> L1(v1->v2) -> L2/L3 -> 召回与回查
    for p in (L0_PATH, L1_PATH, L2_PATH, L3_PATH):
        if os.path.exists(p):
            os.remove(p)
    e1 = record_l0("S1", "user", "我用商汤 Token Plan 跑下册实验，默认模型是 sensenova-6.8-flash。", day="2026-11-16")
    e2 = record_l0("S1", "user", "下周三上午我去体检，需要空腹。", day="2026-11-16")
    e3 = record_l0("S2", "user", "体检改期了，改到 2026-11-27 周五上午。", day="2026-11-17")

    publish_l1("环境配置", "默认模型", "使用商汤 Token Plan，默认 sensenova-6.8-flash", [e1["event_id"]])
    publish_l1("日程安排", "体检时间", "2026-11-25 周三上午体检，需空腹", [e2["event_id"]])
    v2 = publish_l1("日程安排", "体检时间", "改期至 2026-11-27 周五上午体检，需空腹", [e3["event_id"]])

    print("== 召回结果（只含 active 最新版，绝不带出已作废的周三安排）==")
    print(recall("体检"))
    print("\n== 顺着来源锚点回查 L0 原话 ==")
    print(read_events(v2["source_events"]))
