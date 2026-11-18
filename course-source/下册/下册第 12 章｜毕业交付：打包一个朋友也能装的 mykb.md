# 下册第 12 章｜毕业交付：打包一个朋友也能装的 `mykb`

*这一章做完：你把前面十一章亲手敲出来的多格式解析、混合检索、溯源问答、Skill 统计、MCP 服务和回归评测，全部装配成一个标准的 Python 可安装包 `mykb`。装好之后，一条命令就能把《上册》或你自己的 Obsidian 笔记库接进来天天用。对应上册第 14 章、尾声与写在最后。*

## 从“一抽屉零件”到“一台交得出去的机器”

回头点一点这十一章你在 `课件/` 抽屉里攒下的零件：

- **第 01–02 章（通信与格式）**：`llm.py` 与 `cards.py`——连上商汤 Token Plan，支持流式输出、SHA-256 本地缓存、预算保险丝、三分法与严格 JSON Schema 校验；
- **第 03–04 章（解析与检索）**：`ingest.py`、`search.py` 与 `ask.py`——把 Markdown、PDF 和教学视频洗成带行号的纯文本，代码块感知切块，BM25 + 向量/Bigram 双路召回 + RRF 融合 + Rerank 精排，句句带 `[文件名:行号]` 出处；
- **第 05–08 章（手、圈、协议与规矩）**：`toolbox.py`、`loop.py`、`mcp_server.py` 与 `skills.py`——最小权限路径沙箱、每步 Checkpoint 断点续传、零依赖标准 MCP 服务，以及目录常驻/正文按需/脚本本地跑的三层 Skill；
- **第 09–11 章（记忆、并发与评测）**：`memory.py`、`worker.py` 与 `eval.py`——L0–L3 不可变版本谱系记忆、`fcntl.flock` 单写者锁 + 请求幂等键 + 独立行号审查，外加 `Hit@3 / MRR` 自动化回归考卷。

每一个零件都在它自己那一章里跑通过。可如果同事或者朋友看了觉得好，说“发我一份，我也想拿它查我的 Obsidian 笔记”，你总不能让人家一会儿 `cd ch03` 跑个脚本、一会儿又改 `sys.path` 去 `ch04` 调函数。

上册第 14 章讲过：**“做出来”是给自己看的，“交得出去”才是工程的终点。** 今天最后一章，我们把所有零件收拢进一个标准的 Python 包 `mykb_pkg`，装好之后，在电脑的任何地方敲一句 `mykb` 就能调遣全套本事。

![[零基础学AI/attachments/下册第 15 章｜毕业项目：一个你自己的助手/Dlm6bXZsuok8PBxUIyQc2uPynde.png|把十一章造出的零件装进同一个机壳，变成一台随叫随到的终端助手。]]

---

## 用 `pyproject.toml` 与 `cli.py` 封装统一入口

在现代 Python 工程里，把代码打成可安装的命令行工具只需要两个文件。

第一个是 `课件/ch12/mykb_pkg/pyproject.toml`，重点是最后那两行 `[project.scripts]`——它告诉 `pip` 在安装时自动生成一个叫 `mykb` 的可执行命令，指向 `mykb/cli.py` 里的 `main()` 函数：

```toml
[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "mykb"
version = "0.1.0"
description = "《从零开始学 AI》下册毕业项目：可本地检索、溯源问答、MCP 接入与自我评测的知识库助手"
requires-python = ">=3.9"

[project.scripts]
mykb = "mykb.cli:main"
```

第二个是 `课件/ch12/mykb_pkg/mykb/cli.py`，它把前十一章的入口串联成 6 条清晰的子命令（`ingest`、`search`、`ask`、`stats`、`eval`、`mcp`）：

```python
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
```

---

## 毕业验收：装起来，把六条命令从头到尾跑一遍

进到 `课件/ch12/mykb_pkg/` 目录下，用可编辑模式（`-e`，改了源码不用重新安装立即生效）装进你的 Python 环境：

```bash
pip install -e 课件/ch12/mykb_pkg
```

现在做一次完整的毕业体检——依次跑一遍统计、检索和回归评测：

```bash
# 1. 调用第 08 章 Skill 脚本统计《上册》规模
mykb stats

# 2. 调用第 04 章混合检索查出处
mykb search "第 07 章里为什么不能一刀切在除外前面？"

# 3. 调用第 11 章回归考卷做全链路体检
mykb eval
```

终端实跑输出：

```
{"md_count": 25, "total_chars": 433980, "video_count": 6}

通道：{'vector': 'Local-Bigram-Cosine', 'rerank': 'Local-Heuristic-Rerank'}
[1] 第 07 章｜它很聪明，却不知道我们的事.md:607-621 (score=8.0)
[2] 第 07 章｜它很聪明，却不知道我们的事.md:620-640 (score=6.5)
[3] 第 07 章｜它很聪明，却不知道我们的事.md:591-608 (score=5.0)

✓ [Q1] rank=1 | 期望=第 02 章｜给它例子，它就能学会吗？.md | 实际Top1=第 02 章｜给它例子，它就能学会吗？.md
...
回归评测汇总：Hit@3 = 6/6 (100.0%), MRR = 0.889
```

而在 Claude Code 或 Cursor 的 MCP 配置文件里，原来那一串长长的脚本路径，现在也可以简化成清清爽爽的一行：

```json
{
  "mcpServers": {
    "mykb": {
      "command": "mykb",
      "args": ["mcp"]
    }
  }
}
```

![[零基础学AI/attachments/下册第 14 章｜交给别人：一个包，一次体检，一张回执/Ncvsbh7Pxo1quyxVVU4cuGqNnXd.png|打成一个干净的包，附上一份能自己跑的体检表，这才算真正交得出去。]]

> **老办法，新地方**
>
> “把散落的内部模块收口到一个门面（Facade / CLI Entrypoint），配上自检命令（`mykb eval` / `healthcheck`）和标准打包描述（`pyproject.toml`）”，这是所有成熟开源软件交付时的共同规矩。里面的算法和模型年年都会换，但这层干净的工程外壳能让你的工具一直活下去。

---

## 留给你的五件毕业改造

这台 `mykb` 是你的起点，不是终点。合上书之后，最值得你亲手接着往下做的有五件事：

1. **指向你自己的 Obsidian 库**：敲一句 `mykb ingest ~/你的Obsidian目录`，把你攒了几年的工作笔记、读书卡片和项目文档真正装进去天天用。
2. **给 `mykb` 加上 `loop` 和 `memory` 子命令**：把第 06 章的断点续传循环和第 09–10 章的 L0–L3 安全并发记忆也挂进 `cli.py`，让 `mykb chat` 支持多轮跨天记忆。
3. **打开云端向量与重排通道**：在商汤 Token Plan 里配好 `EMBED_MODEL` 和 `RERANK_MODEL`，跑一次 `mykb eval`，亲眼看看 `MRR` 能不能从 `0.889` 冲上 `1.000`。
4. **把《上册》的视频字幕喂进去**：给 `上册/videos/` 下的 6 集视频生成 `.srt` 字幕或开启语音转写，重跑 `mykb ingest`，体验一下“搜一句话直接定位到视频第几行台词”。
5. **给自己的笔记库出一张 10 道题的专属考卷**：把你平时最常查却最容易忘的 10 个问题写进 `eval_set.json`。以后每次你想试试新模型、新切块策略，先跑一遍你自己的 `mykb eval`。

---

## 写在下册最后

下册第 01 章开头，你亲手寄出了第一封 HTTP 请求，盯着回执里那 229 个 token 的账单看呆了一会儿。

十二章走完，你没有停留在“会调接口”的表面，而是亲手把缓存、预算保险丝、Schema 边界校验、多格式解析、代码块感知切块、BM25+向量混合检索、RRF 融合、最小权限沙箱、Checkpoint 断点续传、标准 MCP 协议、三层 Skill、L0–L3 版本谱系记忆、单写者锁、幂等键和自动化回归评测，一行一行敲成了你电脑里的 `mykb`。

模型还会继续变快、变便宜，明年也许又会冒出十几个新名词。但只要你亲手把这一整套底座拆装过一遍，新名词出来的时候，你一眼就能看穿它对应的是你这十二章里的哪一颗螺丝钉。

上册结尾说：下一个现场，你就在场。  
下册结尾想对你说的是：**你不光在场，你手里已经有全套家伙事儿了。去搭你自己的东西吧。**
