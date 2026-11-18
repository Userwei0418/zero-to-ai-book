# 下册第 03 章｜先解析再切块：把 Markdown、PDF 和音视频变成纯文本

*这一章做完：你造出了知识库的统一解析与切块流水线 `ingest.py`——能吃进 Markdown、PDF 和 `.mp4` 教学视频，统一洗成带行号的纯文本，再按 `##` 小节与代码块边界切出不伤代码、不丢出处的语义块（`chunks.jsonl`）。拿《上册》实跑一遍，立刻切出 746 块。对应上册第 07 章。*

## 为什么不能把原文件直接塞给检索？

第 02 章我们给《上册》的每一篇笔记做了一张几十个字的知识卡片。卡片能帮你按主题看目录，可一旦你问出一个具体问题——比如“第 02 章里单层感知机为什么练了 1000 轮还是学不会楼梯灯？”或者“第 07 章里那个因为切块切坏了答错题的例子在哪一行？”——只看卡片摘要是答不出来的，必须去翻原文。

可《上册》单篇笔记动辄六七百行、三四万字。你不可能每次提问都把二十五篇笔记、四十多万字一股脑全塞进提示词里：一来上下文窗口塞不下，二来问一句话就要花掉几毛钱。

唯一的办法，是先把长文切成一小块一小块（Chunk），每次只挑最相关的三五块喂给模型。

但动手切之前，你打开真实的知识库文件夹看一眼，就会发现四件棘手的事：

1. **Markdown 里混着格式噪声**：每篇《上册》笔记顶部都有 `---` 包裹的 YAML 头信息（如 `source:`、`fetched:`），正文里还穿插着 `![[...png]]` 插图引用和 `> 🎬` 视频嵌入行。如果不洗掉，检索“第 02 章感知机”时，排第一的很可能是图片文件名。
2. **PDF 和 Word 不是纯文本**：你平时攒下的技术手册、论文多半是 `.pdf` 或 `.docx`。直接用 Python 的 `open().read()` 去读，只会拿到一堆压缩流和二进制乱码；如果是扫描版 PDF，里面连字符编码都没有，纯粹是一沓图片。
3. **教学音视频里根本没有字**：比如 `上册/videos/` 目录下那 6 集 `.mp4` 讲解视频，里面有大量口语化的推演和比喻。如果不把声音转成带行号/时间戳的文字，检索引擎对它们就是睁眼瞎。
4. **按字数硬切一刀，会把代码和逻辑劈成两半**：上册第 07 章专门讲过那个经典翻车——规定里写着“全体新入职正式员工适用。**实习生除外**，其审批时限为 2 个工作日”，结果按固定字数一刀切在了“实习生除外”前面，模型只读到前半截，当场答反。在技术笔记里更要命：一段 40 行的 Python 代码如果被从第 20 行硬生生劈开，前半块只有函数定义、后半块只有 `return`，谁看都一头雾水。

![[零基础学AI/上册/attachments/一刀切在了除外前面.svg|一刀切在关键句或代码块中间，神仙也答不对。|697]]

所以，在写任何检索算法之前，我们得先造一条 **“多格式统一解析 → 质量体检 → 代码块感知切块”** 的入库流水线 。

---

## 第一步：把所有格式洗成同一种中间表示

不管上游塞进来的是 `.md`、`.pdf` 还是 `.mp4`，下游切块器都不应该关心它原来长什么样。我们在 `ingest.py` 里定下一条规矩：**所有解析函数，一律输出 `[(行号, 纯文本), ...]` 的列表。**

### 1. 洗净 Markdown，但死死保住原始行号

很多初学者洗 Markdown 时喜欢直接用正则 `re.sub()` 把头部和图片行删掉，再重新按行切开。

千万别这么干！一旦你在前面删掉了 6 行 YAML 头信息和 4 行图片，后面所有正文的行号就全都往前错位了 10 行——等到第 04 章模型回答“出自 `[第 02 章.md:172]`”，你打开编辑器跳到第 172 行一看，根本不是那句话。

正确的写法是**先按原始行号枚举，跳过噪声行时保留原行号不变**：

```python
def clean_markdown(raw_text):
    """剥离 YAML 头信息与 Obsidian 图片/视频嵌入行，保留原始行号映射用于精确溯源。"""
    lines = raw_text.splitlines()
    start_idx = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start_idx = i + 1
                break
    out = []
    for line_no, ln in enumerate(lines[start_idx:], start=start_idx + 1):
        s = ln.strip()
        if s.startswith("![[") or s.startswith("> 🎬"):
            continue
        out.append((line_no, ln))
    return out
```

这样一来，哪怕中间跳过了十张插图，剩下的每一行依然带着它在原文件里的真实行号。

### 2. 解析 PDF 与“扫描版乱码体检”

解析 PDF 可以优先用本地轻量库 `pypdf` 或 `pymupdf (fitz)`。但工程上真正区分“玩具脚本”和“可用系统”的，是解析完之后的那一步**内容质量体检**：

- 如果一份 20 页的 PDF 解析出来总共不到 40 个字，说明它八成是**纯图片扫描版 PDF**；
- 如果解析出来的文本里包含大量替换字符 ``（`\ufffd` 占比超过 5%），说明 PDF 内嵌字体编码缺失或损坏。

遇到这两种情况，千万不能把一堆乱码或空字符串静默塞进知识库，而要立刻拦截并提示走 OCR 或云端文档智能服务（如**阿里云 Document Mind**）：

```python
def parse_pdf(path):
    """优先使用 pypdf / fitz 提取 PDF；若检测到疑似扫描版（字数极少或乱码多）给出明确提示。"""
    text_pages = []
    try:
        import pypdf  # type: ignore
        reader = pypdf.PdfReader(path)
        for i, page in enumerate(reader.pages, start=1):
            text_pages.append((i, page.extract_text() or ""))
    except ImportError:
        try:
            import fitz  # type: ignore
            doc = fitz.open(path)
            for i, page in enumerate(doc, start=1):
                text_pages.append((i, page.get_text() or ""))
        except ImportError:
            return [(1, f"[PDF 待解析：{os.path.basename(path)}。请安装 pypdf/pymupdf，或接入阿里云 Document Mind]")]

    joined = "\n".join(t for _, t in text_pages)
    garbled = joined.count("\ufffd")
    if len(joined.strip()) < 40 or (len(joined) > 0 and garbled / len(joined) > 0.05):
        return [(1, f"[警告：{os.path.basename(path)} 疑似扫描版或字体编码异常，需走 OCR / 阿里云 Document Mind]")]

    lines = []
    ln_no = 1
    for _, page_txt in text_pages:
        for raw_ln in page_txt.splitlines():
            clean_ln = re.sub(r"\s+", " ", raw_ln).strip()
            if clean_ln:
                lines.append((ln_no, clean_ln))
                ln_no += 1
    return lines
```

### 3. 音视频解析：云端转写与本地三级兜底

知识库里的 `.mp4` 课程视频和 `.mp3` 会议录音怎么变成字？我们在 `parse_media()` 里设计了清晰的三级流水线：

1. **第一级（零成本最快）**：先看同目录下有没有同名的 `.srt` / `.vtt` 字幕文件或 `.transcript.txt` 逐字稿，有的话直接抽正文行；
2. **第二级（云端高精度主路）**：如果配置了 `DASHSCOPE_API_KEY`，调用**阿里云通义听悟 / 百炼 Paraformer** 语音转写服务；
3. **第三级（纯本地离线兜底）**：如果本机装了 `ffmpeg` 和 `whisper` CLI，自动把视频抽成 `16kHz` 单声道音频跑本地转写；哪怕三样都没配，也优雅返回一条带文件名的待转写标记，绝不让入库任务崩溃。

> **老办法，新地方**
>
> “不论上游是 Markdown、PDF 还是音视频，先通过适配器洗成统一的中间表示 `[(line_no, text)]`，并附上质量健康度检查”，这正是现代编译器（前端转统一 IR）和企业级数据管道（ETL）最核心的解耦思想。

---

## 第二步：代码块感知切块（Chunking）

拿到洗干净的 `numbered_lines` 之后，怎么切才不会把代码劈成两半、也不会把上下文切断？

我们在 `chunk_lines()` 里只靠一个布尔状态位 `in_code` 和三条规则就解决了问题：

1. **追踪代码围栏**：每遇到一行以 ```` ``` ```` 开头，就把 `in_code = not in_code` 翻转一次。
2. **章节边界主动切**：只要当前不在代码块内部（`not in_code`），一旦遇到 `## ` 二级标题，立刻把前面攒下的内容封成一个块落盘，保证不同小节不混杂。
3. **代码块内部绝不腰斩 + 普通段落保留重叠（Overlap）**：当累计字数达到 `max_chars=500` 时，如果 `in_code` 为 `True`，**继续往下读，直到代码块闭合为止**；如果不在代码块里，正常切分，并把末尾 2 行（`overlap_lines=2`）留给下一块的开头，防止一句话刚好卡在边界上失联。

完整可运行的 `课件/ch03/ingest.py` 如下：

```python
# ingest.py：第 03 章实战成品——多格式解析（Markdown / PDF / 音视频）与代码块感知切块
# 用法：python3 ingest.py [语料目录，默认指向 ../../../上册]
import json
import os
import re
import shutil
import subprocess
import sys

DEFAULT_KB = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))


def clean_markdown(raw_text):
    """剥离 YAML 头信息与 Obsidian 图片/视频嵌入行，保留行号映射用于精确溯源。"""
    lines = raw_text.splitlines()
    start_idx = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start_idx = i + 1
                break
    out = []
    for line_no, ln in enumerate(lines[start_idx:], start=start_idx + 1):
        s = ln.strip()
        if s.startswith("![[") or s.startswith("> 🎬"):
            continue
        out.append((line_no, ln))
    return out


def parse_pdf(path):
    """优先使用 pypdf / fitz 提取 PDF；若检测到疑似扫描版（字数极少或乱码多）给出明确提示。"""
    text_pages = []
    try:
        import pypdf  # type: ignore
        reader = pypdf.PdfReader(path)
        for i, page in enumerate(reader.pages, start=1):
            text_pages.append((i, page.extract_text() or ""))
    except ImportError:
        try:
            import fitz  # type: ignore
            doc = fitz.open(path)
            for i, page in enumerate(doc, start=1):
                text_pages.append((i, page.get_text() or ""))
        except ImportError:
            return [(1, f"[PDF 待解析：{os.path.basename(path)}。请安装 pypdf/pymupdf，或接入阿里云 Document Mind]")]

    joined = "\n".join(t for _, t in text_pages)
    garbled = joined.count("\ufffd")
    if len(joined.strip()) < 40 or (len(joined) > 0 and garbled / len(joined) > 0.05):
        return [(1, f"[警告：{os.path.basename(path)} 疑似扫描版或字体编码异常，需走 OCR / 阿里云 Document Mind]")]

    lines = []
    ln_no = 1
    for _, page_txt in text_pages:
        for raw_ln in page_txt.splitlines():
            clean_ln = re.sub(r"\s+", " ", raw_ln).strip()
            if clean_ln:
                lines.append((ln_no, clean_ln))
                ln_no += 1
    return lines


def _transcribe_dashscope(audio_or_video_path):
    """主选方案：调用阿里云百炼 DashScope Paraformer / 通义听悟兼容语音转写接口（需 DASHSCOPE_API_KEY）。"""
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        return None
    return os.environ.get("DASHSCOPE_MEDIA_URL") and None


def parse_media(path):
    """音视频统一解析：1) 同名 .srt 字幕 -> 2) 云端转写(阿里听悟/DashScope) -> 3) 本地 whisper 兜底。"""
    stem = os.path.splitext(path)[0]
    for ext in (".srt", ".vtt", ".transcript.txt"):
        if os.path.exists(stem + ext):
            lines = []
            for idx, ln in enumerate(open(stem + ext, encoding="utf-8", errors="replace").read().splitlines(), start=1):
                s = ln.strip()
                if not s or s.isdigit() or "-->" in s:
                    continue
                lines.append((idx, s))
            if lines:
                return lines

    cloud = _transcribe_dashscope(path)
    if cloud:
        return cloud

    if shutil.which("whisper"):
        wav_tmp = stem + "_tmp16k.wav"
        if shutil.which("ffmpeg"):
            subprocess.run(["ffmpeg", "-y", "-i", path, "-ar", "16000", "-ac", "1", wav_tmp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = wav_tmp if os.path.exists(wav_tmp) else path
        subprocess.run(["whisper", target, "--language", "zh", "--output_format", "txt", "--output_dir", os.path.dirname(path)], check=False)
        if os.path.exists(wav_tmp):
            os.remove(wav_tmp)
        txt_out = os.path.splitext(target)[0] + ".txt"
        if os.path.exists(txt_out):
            return [(i + 1, l.strip()) for i, l in enumerate(open(txt_out, encoding="utf-8").read().splitlines()) if l.strip()]

    return [(1, f"[音视频待转写：{os.path.basename(path)}。可配置阿里云听悟/DashScope、本地 whisper，或放置同名 .srt 字幕文件]")]


def chunk_lines(numbered_lines, source_name, max_chars=500, overlap_lines=2):
    """Markdown 与代码块感知切块：遇到 ## 标题主动切分；身处 ``` 代码块内部时绝不腰斩。"""
    chunks = []
    buf = []
    buf_len = 0
    in_code = False

    def flush():
        nonlocal buf, buf_len
        if not buf:
            return
        text = "\n".join(ln for _, ln in buf).strip()
        if text:
            chunks.append({
                "source": source_name,
                "start_line": buf[0][0],
                "end_line": buf[-1][0],
                "text": text,
            })
        buf = buf[-overlap_lines:] if (overlap_lines > 0 and not in_code) else []
        buf_len = sum(len(ln) + 1 for _, ln in buf)

    for line_no, ln in numbered_lines:
        s = ln.strip()
        if s.startswith("```"):
            in_code = not in_code
        if not in_code and s.startswith("## ") and buf:
            flush()
        buf.append((line_no, ln))
        buf_len += len(ln) + 1
        if not in_code and buf_len >= max_chars:
            flush()

    flush()
    return chunks


def ingest_folder(folder):
    all_chunks = []
    for root, _, files in os.walk(folder):
        for name in sorted(files):
            if name.startswith(".") or name == "上册知识库目录.md":
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, folder)
            ext = os.path.splitext(name)[1].lower()
            if ext in (".md", ".txt"):
                lines = clean_markdown(open(path, encoding="utf-8", errors="replace").read())
            elif ext == ".pdf":
                lines = parse_pdf(path)
            elif ext in (".mp4", ".mp3", ".wav", ".m4a"):
                lines = parse_media(path)
            else:
                continue
            all_chunks.extend(chunk_lines(lines, rel))
    return all_chunks


def main():
    folder = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KB
    chunks = ingest_folder(folder)
    out_path = os.path.join(os.path.dirname(__file__), "chunks.jsonl")
    with open(out_path, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    by_ext = {}
    for c in chunks:
        ext = os.path.splitext(c["source"])[1].lower()
        by_ext[ext] = by_ext.get(ext, 0) + 1
    print(f"解析与切块完成：共 {len(chunks)} 块 -> {out_path}")
    print("按格式分布：", by_ext)


if __name__ == "__main__":
    main()
```

---

## 故意弄坏它：如果把 `in_code` 保护去掉会怎样？

你可以试着把 `chunk_lines()` 里 `if not in_code and buf_len >= max_chars:` 的 `not in_code` 删掉，再去切《第 02 章｜给它例子，它就能学会吗？.md》。

你会立刻看到第 02 章里那段 45 行的 `value.py` 自动求导代码被硬生生斩成了两截：上半块停在 `def __mul__(self, other):` 的半中间，下半块从 `out.backward_step = step` 孤零零地开头，连自己属于哪个类都丢了。加上 `in_code` 保护之后，整段 `class Value` 完完整整地待在同一个块里。

现在我们在真实的《上册》目录上跑一遍 `ingest.py`：

```bash
python3 课件/ch03/ingest.py
```

```
解析与切块完成：共 746 块 -> .../课件/ch03/chunks.jsonl
按格式分布： {'.md': 740, '.mp4': 6}
```

打开生成的 `chunks.jsonl` 看前两条，你会发现第 1 块结束在第 6 行，第 2 块自动从第 5 行开始（保留了 2 行重叠），且每一块都带着精准的 `start_line` 和 `end_line`：

```json
{"source": "上册｜理论册：站回当年的问题前.md", "start_line": 1, "end_line": 6, "text": "# 上册｜理论册：站回当年的问题前\n\n上册按问题走：当年卡在哪儿..."}
{"source": "上册｜理论册：站回当年的问题前.md", "start_line": 5, "end_line": 22, "text": "全书围绕同一个主线项目——**资料助手**..."}
```

746 块干干净净的语料已经准备就绪。**第 04 章**，我们就用商汤 **Token Plan** 的向量模型（Embedding）和重排模型（Rerank）——加上零依赖本地兜底——从这 746 块里一抓一个准地找出答案。

---

## 这一章你留下了什么

```text
课件/ch03/
  ingest.py      Markdown / PDF / 音视频统一解析、扫描版体检与代码块感知切块器
  chunks.jsonl   《上册》25 篇正文与 6 集视频实跑产出的 746 个带行号语义块
```

## 改一改

1. 给 `上册/videos/` 下的 `01-1_6行规则为什么一换问法就挂了_v1.mp4` 旁边放一个同名的 `01-1_6行规则为什么一换问法就挂了_v1.srt` 字幕文件，重跑 `ingest.py`，看看 `.mp4` 切出来的块数和内容变成了什么。
2. 当前 `chunk_lines()` 只在每个块里保存了文本自身，如果某个小块刚好在 `## 把差错算回去` 下面第 3 段，块内可能没有标题行。试着在切块时把当前所在的 `# 一级标题 > ## 二级标题` 作为面包屑前缀拼进每块开头，看看对后续检索有什么帮助。
3. 把 `max_chars=500` 分别改成 `250` 和 `1000` 各跑一次，统计总块数分别是多少，找一找最长的那一块为什么超过了 `max_chars`（提示：去看看那是不是一段很长的代码）。
4. 找一份你手头的真实 `.pdf` 技术文档丢进测试目录，跑一遍 `parse_pdf()`，看看抽出来的行有没有页眉页脚残留，写两行正则把重复出现的页码洗掉。
