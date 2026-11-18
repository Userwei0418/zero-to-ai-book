# 下册第 04 章｜读懂了再找：BM25 + 向量混合检索、Rerank 与行级溯源

*这一章做完：你的知识库第一次真正“问得动”了。`search.py` 用手写 BM25 + 商汤 Token Plan 向量模型双路召回、RRF 倒数排名融合与 Rerank 精排（均自带纯本地零依赖兜底与向量缓存），`ask.py` 则把命中的摘录连同 `[文件名:行号]` 喂给模型，答不出来老实说不知道。对应上册第 07 章。*

## 单靠一种检索，为什么总会漏？

第 03 章已经把《上册》洗净切成了 746 块（`chunks.jsonl`）。现在你在终端里敲入一个问题，怎样从 746 块里挑出最对路的那 5 块？

如果你去翻市面上的入门教程，一半教你用关键词搜索（比如 Elasticsearch 或 BM25），另一半教你用向量检索（Embedding）。但只要真拿《上册》笔记试几个问题，你会发现**单靠哪条腿走路都会摔跤**：

- **只用关键词检索（BM25）**：你问“怎么防止模型把练习题背得滚瓜烂熟、换道新题就不会？”，原文第 02 章写的是“**泛化**”和“**过拟合**”。要是问题和原文刚好没用同一个词，字面匹配就会漏掉关键段落。
- **只用向量检索（Embedding）**：你问“请找一下 `cut.py` 切完‘开发环境部署失败了’输出什么？”，或者搜某个错误码 `401`、某个精确函数名 `safe_path`。向量模型把整段话揉成一串浮点数之后，对这种精确符号反而很迟钝，常常把别的讲代码切分的段落排到前面。

![[零基础学AI/attachments/下册第 5 章｜读懂了再找：一串数，一个出处/CcGWbNOFqog2i5xkH2JcnKQunXf.png|字面检索咬住精确符号，向量检索理解同义表达，两条腿一起走才稳。]]

企业级 RAG 系统的标准解法，是把两条腿绑在一起走：**BM25 关键词召回 + Embedding 向量召回 → RRF 倒数排名融合 → Rerank 交叉精排**。

更重要的是，为了让你在任何环境下都能直接跑通课件，我们在每一层都设计了 **“Token Plan 云端模型主路 + 纯 Python 零依赖本地兜底”**：

| 检索阶段 | 主路（已配 Token Plan 环境变量） | 零依赖本地兜底（未配向量/重排模型或离线） |
|-|-|-|
| **第一路：关键词召回** | 纯 Python 手写 `BM25Index`（中英混排分词，取 Top 20） | 同左（本来就是纯本地零依赖） |
| **第二路：语义召回** | 调 Token Plan `/embeddings` 接口 + `.vec_cache/` 本地哈希缓存（取 Top 20） | 纯 Python 中文双字（Bigram）稀疏余弦相似度（取 Top 20） |
| **双路融合** | `rrf_fuse()` 倒数排名融合：`1 / (60 + rank)`，挑出前 20 个候选 | 同左 |
| **最终精排** | 调 Token Plan `/rerank` 重排模型，精选 Top 5 | 本地词组覆盖率 + 小节标题命中加权（`×1.5`），精选 Top 5 |

---

## 亲手拆开混合检索的四个零件

### 1. 中英混排分词与手写 BM25

中文没有空格分隔。如果不想装几十兆的第三方分词库，一个极其实用的工程巧招是：**英文和数字按完整单词提取，中文同时提取“单字”和“相邻两个字（Bigram）”**。比如 `"感知机"` 会被拆成 `["感", "知", "机", "感知", "知机"]`——既不漏单字，又能精准咬住双字词组。

接着，BM25 给每个词算一个权重：这个词在越少的段落里出现过（如 `ELIZA`、`感知机`），它的区分度（IDF）就越高；在当前块里出现次数越多，得分也越高，但受块长度归一化约束，免得长段落占便宜。

### 2. 向量检索与 `.vec_cache/` 本地缓存

746 个文本块如果每次提问都重新调一次 `/embeddings` 接口，不仅要等好几秒，还会重复花钱。我们在 `vector_search()` 里用每块文本的 SHA-256 哈希做键，把算好的向量存进 `.vec_cache/`——**哪怕你后面改了其中一篇笔记，也只需要为改过的那几块重新算向量，其余 740 块全部零延时直接读盘。**

### 3. 为什么融合不能直接把分数相加？（RRF 倒数排名融合）

BM25 算出来的分数可能是 `14.2`，而余弦相似度算出来的是 `0.83`。两个分数的量纲差了十几倍，直接相加就等于完全听 BM25 的。

**RRF（Reciprocal Rank Fusion，倒数排名融合）** 的想法非常漂亮：**不管你得了多少分，只看你在各自榜单上排第几名。** 在任一榜单排第 `rank` 名，就加上 `1 / (60 + rank)`。如果某一段落在 BM25 排第 2、在向量榜也排第 3，它两边的排名分一叠加，自然稳居榜首。

---

## 第一次实跑踩出的坑：未转写的视频占位块反超了正文

把 `search.py` 写好后，我们马上拿《上册》746 块真实语料试跑第一个问题：“第 02 章里感知机为什么卡在楼梯灯？”

结果第一次跑出来的第 1 名让人哭笑不得：

```
[1] videos/02-1_1958感知机与楼梯灯困境_v1.mp4:1-1 (score=12.5)
    [音视频待转写：02-1_1958感知机与楼梯灯困境_v1.mp4。可配置阿里云听悟/DashScope...]
[2] 第 02 章｜给它例子，它就能学会吗？.md:172-184 (score=7.5)
```

为什么一行还没转写的视频占位提示，得分反而比第 02 章正文还高？

因为那个视频的文件名正好叫 `02-1_1958感知机与楼梯灯困境_v1.mp4`，里面一字不差地包含了“感知机”和“楼梯灯”，而且占位块只有短短一行，词频密度极高、又触发了首行标题加权，直接窜到了榜首！

要是把这一行占位提示当成参考资料喂给大模型，模型只会一头雾水。修复办法非常简单——在 `load_chunks()` 读入切块时加一道过滤：**凡是还没真正完成转写或解析的占位块（以 `[音视频待转写：` 或 `[PDF 待解析：` 开头），一律不进检索索引。**

下面是修复后的完整 `课件/ch04/search.py`：

```python
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
    """主路：Token Plan /embeddings（带本地缓存）；兜底：纯 Python Bigram 稀疏余弦相似度。"""
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
    return sorted(fused.items(), key=lambda x: x[1], reverse=True)


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
```

重新跑一遍 `python3 课件/ch04/search.py "第 02 章里感知机为什么卡在楼梯灯？"`，前三名全部稳稳落回第 02 章讨论单层感知机与楼梯灯局限的核心段落：

```
问题：第 02 章里感知机为什么卡在楼梯灯？
通道：{'vector': 'Local-Bigram-Cosine', 'rerank': 'Local-Heuristic-Rerank'}

[1] 第 02 章｜给它例子，它就能学会吗？.md:172-184 (score=7.5)
    书的末尾，两位作者还多说了一句。他们写道，把感知机推广到多层，在他们的直觉看来，恐怕也同样不会有什么结果...
[2] 第 02 章｜给它例子，它就能学会吗？.md:159-173 (score=6.5)
    请把这句话记下来，后面每次换新模型，我们都会回来问这个问题：**一个模型能学会什么，先要看它的结构装得下什么。**...
[3] 第 02 章｜给它例子，它就能学会吗？.md:623-632 (score=6)
    ---  ## 合上书之前，想一想  1. 感知机学不会楼梯灯，是因为练得不够吗？...
```

> **老办法，新地方**
>
> “初筛用倒排索引 + 向量双路召回（快、高召回），中间用排名融合消掉量纲差异，最后用精排模型挑出前五（慢、高精度）”，这就是搜索引擎和推荐系统用了二十年的**多级漏斗架构（粗排 → 精排）**。

---

## 本章实战成品：句句带 `[文件名:行号]` 的 `ask.py`

找准了段落，最后一步是让模型看着这 5 段摘录回答问题，并且立下两条铁律：

1. **每一条核心结论后面必须标出 `[文件名:起始行-结束行]`**，方便读者随时核对原文；
2. **摘录里没有的，直接说“知识库里没有查到相关依据”**，绝不允许模型用自己背过的场外常识瞎补。

![[零基础学AI/attachments/下册第 5 章｜读懂了再找：一串数，一个出处/GhmibKRzGoOY4WxrWxecFSBLnnf.png|每一句结论都栓着一根绳子，顺着绳子能拉回原文的那一行。]]

完整代码见 `课件/ch04/ask.py`：

```python
# ask.py：第 04 章实战成品——把《上册》语料接进混合检索，带 [文件名:行号] 严格溯源问答
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
```

到这里，你的知识库第一次能回答问题了。但它现在还是 **“被动喂食”**——你事先用固定问题搜一次、喂给它 5 段话，它只能看着这 5 段答。如果它读完第 1 段发现线索在另一章，或者你想让它顺手把总结写进一篇新笔记里，它连伸手的权利都没有。

**第 05 章**，我们给它装上一双手（Tool Calling），并且用最小权限沙箱管住这双手。

---

## 这一章你留下了什么

```text
课件/ch04/
  search.py   BM25 + Token Plan 向量/本地 Bigram 双路召回 + RRF 融合 + Rerank 精排
  ask.py      严格约束 [文件名:起始行-结束行] 出处的知识库问答机
```

## 改一改

1. 故意拿一个《上册》里绝对没有的问题去问 `ask.py`（比如 `python3 ask.py "公司食堂几点开饭？"`），看看模型是老老实实回答“知识库里没有查到相关依据”，还是会忍不住编造。
2. 在环境变量里设好 `EMBED_MODEL`（商汤 Token Plan 支持的向量模型），跑两次 `search.py`，观察第二次运行时 `.vec_cache/` 是怎么让 740 个块的向量计算瞬间完成的。
3. 把 `rrf_fuse()` 里的常数 `k=60` 改成 `k=1`，看看当某一段落只在其中一路排第 1、另一路排第 20 时，总排名会发生什么变化。
4. 写一个 10 行的检查函数 `check_citations(reply, hits)`：用正则抠出模型回答里所有的 `[文件名:起始行-结束行]`，核对它们是不是全部落在本次喂给它的 `hits` 列表里——如果有哪个出处不在 `hits` 里，说明模型连出处都在瞎编。
