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
