# worker.py：第 10 章实战成品——多助手并发治理（单写者文件锁 + 请求幂等键 + 独立出处核对）
import fcntl
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch09")))
import memory

STATE_DIR = os.path.join(os.path.dirname(__file__), "worker_state")
LOCK_PATH = os.path.join(STATE_DIR, "kb_write.lock")
IDEM_PATH = os.path.join(STATE_DIR, "idempotency.json")
KB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))


def verify_citation(filename, line_no):
    """独立只读审查员：核对宣称的 [文件名:行号] 是否真实存在于上册目录内。"""
    p = os.path.abspath(os.path.join(KB_ROOT, filename))
    if not p.startswith(KB_ROOT + os.sep) or not os.path.isfile(p):
        return False, f"文件不存在：{filename}"
    lines = open(p, encoding="utf-8").read().splitlines()
    if not (1 <= int(line_no) <= len(lines)):
        return False, f"行号越界：{filename}:{line_no}（共 {len(lines)} 行）"
    return True, lines[int(line_no) - 1][:60]


def safe_publish(request_id, topic, key, fact, source_file, source_line):
    """拿到单写者锁后先查幂等表，再核对出处，通过后才写入 L1 记忆。"""
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOCK_PATH, "w", encoding="utf-8") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            idem = json.load(open(IDEM_PATH, encoding="utf-8")) if os.path.exists(IDEM_PATH) else {}
            if request_id in idem:
                return {"status": "dedup_hit", "request_id": request_id, "atom_id": idem[request_id]["atom_id"]}

            ok, detail = verify_citation(source_file, source_line)
            if not ok:
                return {"status": "rejected_citation", "reason": detail}

            ev = memory.record_l0("worker", "system", f"[{source_file}:{source_line}] {fact}")
            atom = memory.publish_l1(topic, key, fact, [ev["event_id"]])
            idem[request_id] = {"atom_id": atom["atom_id"], "at": time.strftime("%H:%M:%S")}
            with open(IDEM_PATH, "w", encoding="utf-8") as f:
                json.dump(idem, f, ensure_ascii=False, indent=2)
            return {"status": "written", "request_id": request_id, "atom_id": atom["atom_id"]}
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


if __name__ == "__main__":
    for p in (IDEM_PATH, memory.L0_PATH, memory.L1_PATH):
        if os.path.exists(p):
            os.remove(p)

    results = []
    def task(rid, fact, line):
        results.append(safe_publish(rid, "并发测试", "规则教训", fact, "第 01 章｜规则总也写不完.md", line))

    # 模拟并发：两个线程拿同一个 req_001 重试，第三个线程拿假行号 99999
    threads = [
        threading.Thread(target=task, args=("req_001", "答对了不等于弄懂了", 131)),
        threading.Thread(target=task, args=("req_001", "答对了不等于弄懂了", 131)),
        threading.Thread(target=task, args=("req_002", "编造的结论", 99999)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    for r in results:
        print(r)
