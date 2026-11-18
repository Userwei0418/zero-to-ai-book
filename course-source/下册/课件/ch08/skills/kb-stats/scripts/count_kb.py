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
