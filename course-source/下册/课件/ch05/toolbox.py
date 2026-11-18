# toolbox.py：第 05 章核心——工具注册表、JSON Schema 自动生成与最小权限路径沙箱
import json
import os

KB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../上册"))
SANDBOX_NOTES = os.path.abspath(os.path.join(os.path.dirname(__file__), "notes_sandbox"))


class SandboxError(Exception):
    """越权路径或被沙箱拦截的危险操作。"""


def safe_path(root, rel_path):
    """把相对路径解析到 root 内部；任何 ../ 逃逸或绝对路径直接拦截。"""
    if os.path.isabs(rel_path):
        raise SandboxError(f"拒绝绝对路径：{rel_path}")
    target = os.path.abspath(os.path.join(root, rel_path))
    if target != root and not target.startswith(root + os.sep):
        raise SandboxError(f"路径逃逸被沙箱拦截：{rel_path}")
    return target


TOOLS = {}


def tool(desc, mode="read", **params):
    """把普通 Python 函数注册为可供模型调用的工具，并标明只读(read)或写入(write)权限。"""
    def deco(fn):
        props = {k: {"type": "string", "description": v} for k, v in params.items()}
        TOOLS[fn.__name__] = {
            "fn": fn,
            "mode": mode,
            "spec": {
                "type": "function",
                "function": {
                    "name": fn.__name__,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props, "required": list(params.keys())},
                },
            },
        }
        return fn
    return deco


@tool("列出知识库里的 Markdown 文件名", mode="read", keyword="可选过滤关键词，留空则列出全部")
def list_notes(keyword=""):
    files = sorted(f for f in os.listdir(KB_ROOT) if f.endswith(".md"))
    if keyword:
        files = [f for f in files if keyword in f]
    return json.dumps(files[:30], ensure_ascii=False)


@tool("按文件名读取《上册》笔记的指定行范围", mode="read", filename="笔记文件名", start_line="起始行号(从1开始)", end_line="结束行号")
def read_note(filename, start_line="1", end_line="60"):
    path = safe_path(KB_ROOT, filename)
    if not os.path.exists(path):
        return f"找不到文件：{filename}"
    s = max(1, int(start_line))
    e = min(s + 120, int(end_line))
    lines = open(path, encoding="utf-8").read().splitlines()
    slice_lines = [f"{i}: {ln}" for i, ln in enumerate(lines[s - 1 : e], start=s)]
    return "\n".join(slice_lines) if slice_lines else "该行范围为空"


@tool("在学习笔记沙箱目录里新建或追加一篇读书笔记（绝不触碰上册原文）", mode="write", filename="新建笔记文件名(如 学习心得.md)", content="笔记正文内容")
def write_study_note(filename, content):
    os.makedirs(SANDBOX_NOTES, exist_ok=True)
    path = safe_path(SANDBOX_NOTES, filename)
    with open(path, "a", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n\n")
    return f"已安全写入沙箱笔记：{os.path.relpath(path, SANDBOX_NOTES)}"


def specs(allow_write=False):
    """默认只把只读工具交给模型；只有显式允许时才开放写入工具。"""
    return [t["spec"] for t in TOOLS.values() if allow_write or t["mode"] == "read"]


def execute(tool_call, allow_write=False):
    name = tool_call["function"]["name"]
    if name not in TOOLS:
        return f"未知工具：{name}"
    entry = TOOLS[name]
    if entry["mode"] == "write" and not allow_write:
        return f"权限拒绝：当前为只读模式，不能执行写入工具 {name}"
    args = json.loads(tool_call["function"].get("arguments") or "{}")
    try:
        return str(entry["fn"](**args))
    except SandboxError as e:
        return f"沙箱拦截：{e}"
    except Exception as e:
        return f"工具执行出错：{e}"
