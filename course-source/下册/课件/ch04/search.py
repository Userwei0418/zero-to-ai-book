# search.py：第 04 章核心检索引擎——BM25 + 向量混合检索 + RRF 融合 + Rerank（均内置零依赖兜底与向量缓存）
# 用法：python3 search.py "你的问题"
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request

CHUNKS_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../ch03/chunks.jsonl"))
VEC_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".vec_cache")


def tokenize(text):
    """中英混排分词：英文/数字按词提取，中文提取单字与相邻双字（Bigram）。"""
    tokens = re.findall(r"[A-Za-z0-9_.\-]+", text.lower())
    cjk_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in cjk_runs:
        tokens.extend(list(run))
        tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


class BM25Index:
    def __init__(self, docs, k1=1.5, b=0.75):
        self.docs = docs
        self.k1, self.b = k1, b
        self.tfs = []
        self.df = {}
        total_len = 0
        for d in docs:
            toks = tokenize(d["text"])
            total_len += len(toks)
            tf = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            self.tfs.append((len(toks), tf))
            for t in tf:
                self.df[t] = self.df.get(t, 0) + 1
        self.avg_len = total_len / max(1, len(docs))
        self.n = len(docs)

    def search(self, query, top_k=20):
        q_toks = tokenize(query)
        scores = []
        for idx, (dl, tf) in enumerate(self.tfs):
            s = 0.0
            for qt in q_toks:
                if qt not in tf:
                    continue
                df = self.df[qt]
                idf = math.log((self.n - df + 0.5) / (df + 0.5) + 1.0)
                f = tf[qt]
                denom = f + self.k1 * (1.0 - self.b + self.b * dl / max(1e-9, self.avg_len))
                s += idf * (f * (self.k1 + 1.0)) / denom
            if s > 0:
                scores.append((idx, s))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_k]


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na > 0 and nb > 0 else 0.0


def _call_embeddings(texts, model, base_url, api_key):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/embeddings",
        data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]


def vector_search(query, docs, top_k=20):
    """主路：Token Plan /embeddings（带本地缓存）；兜底：纯 Python Bigram TF-IDF 余弦相似度。"""
    api_key = os.environ.get("LLM_API_KEY", "")
    embed_model = os.environ.get("EMBED_MODEL", "")
    base_url = os.environ.get("LLM_BASE_URL", "https://token.sensetime.com/api/v1")

    if api_key and embed_model:
        try:
            os.makedirs(VEC_CACHE_DIR, exist_ok=True)
            cache_file = os.path.join(VEC_CACHE_DIR, f"{embed_model.replace('/', '_')}.json")
            cache = json.load(open(cache_file, encoding="utf-8")) if os.path.exists(cache_file) else {}
            missing_idx, missing_txt = [], []
            doc_vecs = [None] * len(docs)
            for i, d in enumerate(docs):
                h = hashlib.sha256(d["text"].encode("utf-8")).hexdigest()[:16]
                if h in cache:
                    doc_vecs[i] = cache[h]
                else:
                    missing_idx.append((i, h))
                    missing_txt.append(d["text"][:1500])
            for s in range(0, len(missing_txt), 16):
                vecs = _call_embeddings(missing_txt[s : s + 16], embed_model, base_url, api_key)
                for (i, h), v in zip(missing_idx[s : s + 16], vecs):
                    doc_vecs[i] = v
                    cache[h] = v
            if missing_idx:
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(cache, f)
            q_vec = _call_embeddings([query], embed_model, base_url, api_key)[0]
            scored = [(i, _cosine(q_vec, v)) for i, v in enumerate(doc_vecs) if v is not None]
            scored.sort(key=lambda x: x[1], reverse=True)
            return scored[:top_k], "TokenPlan-Embedding"
        except Exception:
            pass

    # 零依赖兜底：Bigram 稀疏余弦相似度
    q_toks = set(tokenize(query))
    scored = []
    for i, d in enumerate(docs):
        d_toks = set(tokenize(d["text"]))
        inter = len(q_toks & d_toks)
        if inter:
            sim = inter / math.sqrt(len(q_toks) * len(d_toks))
            scored.append((i, sim))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:top_k], "Local-Bigram-Cosine"


def rrf_fuse(rank_lists, k=60):
    """倒数排名融合（Reciprocal Rank Fusion）：不看各路原始分数量纲，只看排名。"""
    fused = {}
    for rlist in rank_lists:
        for rank, (doc_idx, _) in enumerate(rlist, start=1):
            fused[doc_idx] = fused.get(doc_idx, 0.0) + 1.0 / (k + rank)
    out = sorted(fused.items(), key=lambda x: x[1], reverse=True)
    return out


def rerank(query, docs, candidate_ids, top_k=5):
    """主路：Token Plan /rerank 精排；兜底：关键词覆盖率 + 标题命中加权。"""
    api_key = os.environ.get("LLM_API_KEY", "")
    rerank_model = os.environ.get("RERANK_MODEL", "")
    base_url = os.environ.get("LLM_BASE_URL", "https://token.sensetime.com/api/v1")

    if api_key and rerank_model and candidate_ids:
        try:
            passages = [docs[i]["text"][:1500] for i in candidate_ids]
            req = urllib.request.Request(
                base_url.rstrip("/") + "/rerank",
                data=json.dumps({"model": rerank_model, "query": query, "documents": passages, "top_n": top_k}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                res = json.loads(resp.read().decode("utf-8"))
            ranked = [(candidate_ids[item["index"]], item.get("relevance_score", 0.0)) for item in res.get("results", [])]
            if ranked:
                return ranked[:top_k], "TokenPlan-Rerank"
        except Exception:
            pass

    # 兜底精排：精确词组与标题命中加权
    q_terms = [t for t in tokenize(query) if len(t) >= 2]
    scored = []
    for idx in candidate_ids:
        txt = docs[idx]["text"]
        first_line = txt.splitlines()[0] if txt else ""
        hit = sum(1 for t in q_terms if t in txt.lower())
        title_hit = sum(1.5 for t in q_terms if t in first_line.lower())
        scored.append((idx, hit + title_hit))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:top_k], "Local-Heuristic-Rerank"


def load_chunks(path=CHUNKS_PATH):
    with open(path, encoding="utf-8") as f:
        docs = [json.loads(line) for line in f if line.strip()]
    return [d for d in docs if not d["text"].startswith(("[音视频待转写：", "[PDF 待解析："))]


def hybrid_search(query, docs=None, top_k=5):
    docs = docs if docs is not None else load_chunks()
    bm25 = BM25Index(docs)
    bm25_hits = bm25.search(query, top_k=20)
    vec_hits, vec_mode = vector_search(query, docs, top_k=20)
    fused = rrf_fuse([bm25_hits, vec_hits])
    top_candidates = [idx for idx, _ in fused[:20]]
    reranked, rerank_mode = rerank(query, docs, top_candidates, top_k=top_k)
    results = []
    for idx, score in reranked:
        d = docs[idx]
        results.append({
            "source": d["source"],
            "start_line": d["start_line"],
            "end_line": d["end_line"],
            "score": round(score, 4),
            "text": d["text"],
        })
    return results, {"vector": vec_mode, "rerank": rerank_mode}


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "第 02 章里感知机为什么卡在楼梯灯？"
    hits, modes = hybrid_search(q, top_k=3)
    print(f"问题：{q}\n通道：{modes}\n")
    for rank, h in enumerate(hits, start=1):
        preview = " ".join(h["text"].splitlines())[:90]
        print(f"[{rank}] {h['source']}:{h['start_line']}-{h['end_line']} (score={h['score']})\n    {preview}…")
