# 下册第 08 章｜按需加载的做法包：三层 Skill 引擎

*这一章做完：你不再把十几套规矩全塞进 System Prompt，而是搭出“目录常驻、正文按需取、脚本本地跑”的三层 Skill 引擎 `skills.py`。需要精确统计《上册》篇数、总字数和视频数量时，模型不再靠眼睛瞎猜，而是直接调度做法包自带的 `count_kb.py` 脚本，零幻觉、零多余 Token。对应上册第 10 章。*

## 规矩越写越多，开场白装不下了

到第 07 章为止，你的知识库已经能接进日常助手了。很快你会想给它立各种干活的规矩：

- 整理学习卡片时，必须按“核心问题 + 三条结论 + 关键术语”的模板来，而且要先查原文行号；
- 统计知识库规模时，不能算入自动生成的目录文件，还要把 `videos/` 下的 `.mp4` 教学视频单独算清楚；
- 写每周学习复盘时，要先对一遍本周新增的笔记和记忆，没把握的列进“待核实”。

如果把这十几套规矩的详细步骤全写进 `system` 开场白里，哪怕你只是跟助手打声招呼说句“早上好”，它都要先把这几千字规矩完完整整读一遍。不仅每轮对话白白烧掉几千个 `prompt_tokens`，更糟的是规矩一多，模型反而容易把 A 任务的格式套到 B 任务头上。

![[零基础学AI/attachments/下册第 7 章｜给它一套规矩：分层写，按需给，三层验/R1t2b2O7AoT9IdxESmFczFywnwc.png|不要把整座图书馆的书都背在身上，口袋里只装一张目录卡就够了。]]

---

## 三层渐进式加载：目录常驻 → 正文按需取 → 脚本本地跑

上册第 10 章讲过，**Skill（做法包）** 的精髓不在于“把提示词写进 Markdown 文件”，而在于**按需分层展开**：

1. **第一层（常驻目录层 `catalog()`）**：每个做法包都是 `skills/<名字>/` 下的一个文件夹，里面有一份 `SKILL.md`。平时开场白里**只放每个做法包顶部的 `name` 和一行 `description`**（加起来不到一百字）。
2. **第二层（按需正文层 `load_skill(name)`）**：只有当模型听完你的问题，发现“这活儿对得上 `study-card` 或 `kb-stats`”时，才递纸条调用 `load_skill` 把那一份做法包的正文取进上下文。别的做法包一字不读。
3. **第三层（确定性脚本层 `run_skill_script(name, script)`）**：有些事大模型天生不擅长——比如“数一数《上册》25 篇笔记一共多少个字符”。你让大模型去数，它一定会瞎编一个数；把这活儿写成做法包文件夹里的 `scripts/count_kb.py`，让模型调用 `run_skill_script` 在本地跑一遍 Python 脚本，**耗时 0.02 秒、Token 消耗为 0、精确到个位数。**

![[零基础学AI/attachments/下册第 8 章｜把一套做法打成包：一个文件夹，一份清单/CFjObuohcoFwMfxz7cecpkTIn8g.png|一个文件夹就是一个做法包：上面是名片，中间是说明书，底下是趁手的小工具。]]

---

## 亲手做两个做法包：`kb-stats` 与 `study-card`

我们在 `课件/ch08/skills/` 下建两个真实的做法包。

第一个是专门管精确统计的 `kb-stats/SKILL.md`：

```markdown
---
name: kb-stats
description: 统计《上册》或指定知识库目录的章节数、总字数、代码块数量与视频数量，需要精确统计数据时使用。
---
# 知识库精确统计做法

当用户询问“知识库一共有多少篇、多少字、多少个视频”等精确数量问题时，**不要自己数**，请调用 `run_skill_script` 运行本做法包自带的 `count_kb.py` 脚本，直接把脚本返回的精确统计结果转述给用户。
```

它配套的本地脚本放在 `kb-stats/scripts/count_kb.py`：

```python
# count_kb.py：kb-stats 做法包自带的本地统计脚本，精确统计字数与文件数，不消耗大模型 Token
import json
import os
import sys

KB_ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../../上册"))

md_files = [f for f in os.listdir(KB_ROOT) if f.endswith(".md") and f != "上册知识库目录.md"]
total_chars = sum(len(open(os.path.join(KB_ROOT, f), encoding="utf-8").read()) for f in md_files)
videos_dir = os.path.join(KB_ROOT, "videos")
videos = [f for f in os.listdir(videos_dir) if f.endswith(".mp4")] if os.path.isdir(videos_dir) else []

print(json.dumps({"md_count": len(md_files), "total_chars": total_chars, "video_count": len(videos)}, ensure_ascii=False))
```

第二个是专门管整理学习卡片的 `study-card/SKILL.md`：

```markdown
---
name: study-card
description: 将《上册》某一章或用户粘贴的技术文章整理成“核心问题 + 三条结论 + 关键术语”的学习卡片。
---
# 学习卡片整理做法

1. 先用检索或读文件工具确认原文出处，不要凭记忆编造细节。
2. 卡片固定包含三部分：
   - **核心问题**（一句话说清这一节解决什么卡点）
   - **三条结论**（每条附 `[文件名:行号]`）
   - **关键术语**（2–4 个）
```

---

## 完整三层 Skill 引擎实现：`skills.py`

现在写 `课件/ch08/skills.py`，把这三层加载和脚本沙箱封成三个干净的函数。注意 `run_skill_script()` 里同样用 `os.path.abspath()` 锁死了脚本必须位于对应做法包的 `scripts/` 子目录内，绝不允许模型借机去跑系统别处的脚本：

```python
# skills.py：第 08 章实战成品——三层渐进式 Skill 引擎（目录常驻 → 正文按需取 → 脚本本地跑）
import os
import subprocess
import sys

SKILLS_DIR = os.path.join(os.path.dirname(__file__), "skills")


def _parse_frontmatter(md_text):
    parts = md_text.split("---", 2)
    if len(parts) < 3:
        return {}, md_text
    meta = {}
    for line in parts[1].strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, parts[2].strip()


def catalog(skills_dir=SKILLS_DIR):
    """第一层：只扫描 name 与 description，生成极短目录放进开场白。"""
    rows = []
    for d in sorted(os.listdir(skills_dir)):
        p = os.path.join(skills_dir, d, "SKILL.md")
        if os.path.isfile(p):
            meta, _ = _parse_frontmatter(open(p, encoding="utf-8").read())
            rows.append(f"- {meta.get('name', d)}：{meta.get('description', '')}")
    return "\n".join(rows)


def load_skill(name, skills_dir=SKILLS_DIR):
    """第二层：按需取出对应 Skill 的正文操作步骤。"""
    p = os.path.join(skills_dir, os.path.basename(name), "SKILL.md")
    if not os.path.isfile(p):
        return f"找不到做法包：{name}"
    _, body = _parse_frontmatter(open(p, encoding="utf-8").read())
    return body


def run_skill_script(name, script_name, *args, skills_dir=SKILLS_DIR):
    """第三层：沙箱内运行 Skill 自带的确定性 Python 脚本，零幻觉完成统计或校验。"""
    scripts_root = os.path.abspath(os.path.join(skills_dir, os.path.basename(name), "scripts"))
    target = os.path.abspath(os.path.join(scripts_root, script_name))
    if not target.startswith(scripts_root + os.sep) or not os.path.isfile(target):
        return f"沙箱拦截或脚本不存在：{name}/{script_name}"
    res = subprocess.run([sys.executable, target, *args], capture_output=True, text=True, timeout=30)
    return res.stdout.strip() if res.returncode == 0 else f"脚本报错：{res.stderr.strip()}"


if __name__ == "__main__":
    print("== 第一层：常驻目录 ==")
    print(catalog())
    print("\n== 第二层：按需取出 kb-stats 正文 ==")
    print(load_skill("kb-stats"))
    print("\n== 第三层：本地运行 count_kb.py ==")
    print(run_skill_script("kb-stats", "count_kb.py"))
```

跑一遍 `python3 课件/ch08/skills.py`，三层展开清清楚楚：

```
== 第一层：常驻目录 ==
- kb-stats：统计《上册》或指定知识库目录的章节数、总字数、代码块数量与视频数量，需要精确统计数据时使用。
- study-card：将《上册》某一章或用户粘贴的技术文章整理成“核心问题 + 三条结论 + 关键术语”的学习卡片。

== 第二层：按需取出 kb-stats 正文 ==
# 知识库精确统计做法

当用户询问“知识库一共有多少篇、多少字、多少个视频”等精确数量问题时，**不要自己数**，请调用 `run_skill_script` 运行本做法包自带的 `count_kb.py` 脚本，直接把脚本返回的精确统计结果转述给用户。

== 第三层：本地运行 count_kb.py ==
{"md_count": 25, "total_chars": 433980, "video_count": 6}
```

![[零基础学AI/attachments/下册第 8 章｜把一套做法打成包：一个文件夹，一份清单/JP9nbZCIGoJj9dxzLricE2SXnuf.png|把确定性的计算交给本地脚本，把灵活的理解留给大模型。]]

> **老办法，新地方**
>
> “启动时只加载符号表和入口摘要，真正调用到某个模块时再把代码页换入内存（按需分页 Demand Paging）”，这是操作系统管理内存几十年的老办法。搬到 Agent 里，就是三层 Skill：**目录常驻省空间，正文按需保专注，脚本执行守精确。**

现在，你的助手既有工具箱（MCP），又有做法包（Skill）。但它还是个“金鱼脑子”——今天在会话 A 里你告诉它“我用商汤 Token Plan 跑实验，下周三上午要去体检”，明天新开一个会话 B 问它“我哪天体检？”，它一问三不知。

**第 09 章**，我们借鉴企业级记忆系统的设计，亲手搭出 **L0 原始流水账 → L1 原子版本谱系 → L2/L3 归纳** 的分层记忆引擎。

---

## 这一章你留下了什么

```text
课件/ch08/
  skills.py                           三层渐进式 Skill 加载与脚本沙箱执行引擎
  skills/kb-stats/SKILL.md            知识库精确统计做法包
  skills/kb-stats/scripts/count_kb.py 精确统计《上册》篇数、字数与视频数的本地脚本
  skills/study-card/SKILL.md          学习卡片三段式整理做法包
```

## 改一改

1. 给 `count_kb.py` 增加一项统计：遍历《上册》所有 Markdown 文件，数一数一共有多少个 ```` ```python ```` 代码块，把 `"python_blocks"` 字段加进返回的 JSON 里。
2. 在 `skills/` 目录下新建第三个做法包 `weekly-review/SKILL.md`（每周学习复盘），不改一行 `skills.py` 代码直接重跑，看看 `catalog()` 会不会自动发现并列出它。
3. 故意调用 `run_skill_script("kb-stats", "../../skills.py")` 试图跑 `scripts/` 目录外面的文件，验证路径前缀检查有没有把它拦下来。
4. 把 `load_skill` 和 `run_skill_script` 两个函数用第 05 章的 `@tool` 装饰器注册进工具箱，让大模型能根据 `catalog()` 自己递纸条加载做法包。
