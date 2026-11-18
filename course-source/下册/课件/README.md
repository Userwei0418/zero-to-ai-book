# 《从零开始学 AI（下册）》配套课件总览

本目录为《下册｜实践册》全部 12 章的可运行 Python 配套代码，默认直接以 `../../../上册/`（《上册》25 篇 Markdown 与 6 集教学视频）作为知识库语料。

## 环境准备

核心主线仅依赖 **Python 3.9+ 标准库**；如需调用云端大模型或向量/重排能力，配置商汤 **Token Plan**（或任何兼容 OpenAI 协议的接口）环境变量即可：

```bash
export LLM_BASE_URL="https://token.sensetime.com/api/v1"
export LLM_API_KEY="你的密钥"
export LLM_MODEL="sensenova-6.8-flash"

# 可选：配置向量与重排模型（未配置时第 04 章自动使用纯 Python Bigram 兜底）
export EMBED_MODEL="你的Embedding模型名"
export RERANK_MODEL="你的Rerank模型名"
```

## 分章课件清单

| 章节 | 目录 / 入口 | 说明 |
|-|-|-|
| 第 01 章 | `ch01/` (`raw.py`, `llm.py`, `oops.py`, `streaming.py`, `index_kb.py`) | Token Plan 接入、流式输出、本地缓存、预算保险丝、批量目录生成 |
| 第 02 章 | `ch02/` (`llm.py`, `cards.py`) | `ask_json()` 结构化输出、封闭词表校验与带错因重试 |
| 第 03 章 | `ch03/` (`ingest.py`, `chunks.jsonl`) | Markdown/PDF/音视频统一解析（含阿里/Whisper/字幕兜底）与代码块感知切块 |
| 第 04 章 | `ch04/` (`search.py`, `ask.py`) | BM25 + 向量/Bigram 混合检索、RRF 融合、Rerank 与行级溯源问答 |
| 第 05 章 | `ch05/` (`toolbox.py`, `agent_tools.py`) | Tool Calling、路径逃逸拦截 `safe_path()` 与读写权限沙箱 |
| 第 06 章 | `ch06/` (`loop.py`) | 多步自主循环、重复调用拦截与 `checkpoints/` 断点续传 |
| 第 07 章 | `ch07/` (`mcp_server.py`, `mcp_client_demo.py`) | 零依赖标准库 MCP stdio 服务与子进程联调脚本 |
| 第 08 章 | `ch08/` (`skills.py`, `skills/`) | 目录常驻、正文按需加载、确定性脚本本地执行的 Skill 引擎 |
| 第 09 章 | `ch09/` (`memory.py`) | L0 流水账 → L1 不可变版本谱系 → L2/L3 归纳与锚点回查 |
| 第 10 章 | `ch10/` (`worker.py`) | `fcntl.flock` 单写者锁、`request_id` 幂等去重与出处核对 |
| 第 11 章 | `ch11/` (`eval.py`, `eval_set.json`) | 固定《上册》回归考卷，`Hit@3` 与 `MRR` 量化评测 |
| 第 12 章 | `ch12/mykb_pkg/` (`pyproject.toml`, `mykb/cli.py`) | 打包好的 `mykb` 统一 CLI 工具，可 `pip install -e .` 一键安装 |
