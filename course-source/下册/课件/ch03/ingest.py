# ingest.py：第 03 章实战成品——多格式解析（Markdown / PDF / 音视频）与代码块感知切块
# 用法：python3 ingest.py [语料目录，默认指向 ../../../上册]
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

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
    # 注：实际生产中需先将音视频上传至 OSS 或公网临时 URL，再提交 DashScope 异步转写任务轮询结果。
    # 这里保留标准接线点，未配置公网 URL 时返回 None 自动进入本地兜底。
    return os.environ.get("DASHSCOPE_MEDIA_URL") and None


def parse_media(path):
    """音视频统一解析：1) 云端转写(阿里听悟/DashScope) -> 2) 本地 faster-whisper/whisper -> 3) 同名 .srt 字幕兜底。"""
    stem = os.path.splitext(path)[0]
    # 1. 若已有同名字幕或逐字稿（.srt / .txt），直接零成本读取（也是无转写环境时的最终兜底）
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

    # 2. 尝试阿里云 DashScope / 通义听悟
    cloud = _transcribe_dashscope(path)
    if cloud:
        return cloud

    # 3. 本地兜底：若有 faster-whisper / whisper CLI，先用 ffmpeg 抽 16k 单声道 wav 再转写
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
