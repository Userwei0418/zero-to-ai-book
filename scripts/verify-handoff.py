#!/usr/bin/env python3
"""Verify the Zero-to-AI handover ZIP offline, using only Python and Git."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile


PREFIX = "zero-to-ai-book-handoff"
QUICK_START = "00-先读我.md"
BUNDLE = "history.bundle"
REFS = {"refs/heads/" + name for name in
        ("main", "archive/original-history", "archive/site-history", "archive/source-snapshot")}
REQUIRED_GUIDES = {
    "docs/TAKEOVER.md", "docs/design/零基础学AI_PRD_含设计图.pdf",
    "docs/editorial/课程介绍.md", "docs/acceptance/ai-book-compact-prediction.jpg",
}
# Reviewed immutable recovery program. Check before executing a script found in a ZIP.
RESTORE_SHA256 = "b5b490e2ebc58089c502380cbbd851428d94667b72c4ab09d0bfb7f5a1bf0a72"
ORIGINAL_TIP = "d0fa0881e575f37fbbcf8b0d49f3f0d75b07aede"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"JSON 字段重复：{key}")
        result[key] = value
    return result


def digest(stream, destination=None):
    sha = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        sha.update(block)
        if destination is not None:
            destination.write(block)
    return sha.hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return digest(stream)


def safe_path(name):
    parts = name.split("/")
    require(all(part and part not in (".", "..") and not part.endswith((".", " "))
                for part in parts), f"路径无效：{name!r}")
    require(not re.search(r'[\\:<>|?*"\x00-\x1f\x7f]', name), f"路径字符无效：{name!r}")
    for part in parts:
        word = unicodedata.normalize("NFKC", part).casefold()
        require(not re.fullmatch(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", word),
                f"路径包含设备名称：{name!r}")
        require(word not in {".git", "git~1", ".ssh", ".aws", ".gnupg", ".codex",
                             ".kube", ".docker", ".netrc", "_netrc", ".git-credentials",
                             "auth.json", "credentials.json", "credentials", "id_rsa",
                             "id_ed25519", "mygpt-companion-20261117-r4-8c90a8fb.zip"}
                and not word.startswith((".dev.vars", ".env"))
                and not word.endswith((".pem", ".p12", ".pfx", ".key", ".env"))
                and not ("credential" in word and word.endswith(".zip")),
                f"包中包含私有配置或授权导出路径：{name!r}")
    return parts


def archive_files(archive):
    files, nodes, explicit = {}, {}, set()
    for item in archive.infolist():
        name = item.orig_filename
        directory = name.endswith("/")
        raw = name[:-1] if directory else name
        parts = safe_path(raw)
        require(parts[0] == PREFIX and (len(parts) > 1 or directory),
                f"ZIP 根目录不正确：{name!r}")
        kind = stat.S_IFMT(item.external_attr >> 16)
        require(kind in (0, stat.S_IFDIR if directory else stat.S_IFREG)
                and not (item.flag_bits & 1) and (not directory or item.file_size == 0),
                f"ZIP 含链接、特殊文件或加密文件：{name!r}")
        require(raw not in explicit, f"ZIP 重复条目：{name!r}")
        explicit.add(raw)
        for i in range(1, len(parts) + 1):
            path = "/".join(parts[:i])
            key = unicodedata.normalize("NFC", path).casefold()
            entry = (path, i < len(parts) or directory)
            require(nodes.setdefault(key, entry) == entry, f"ZIP 路径冲突：{name!r}")
        if len(parts) == 1:
            continue
        rel = "/".join(parts[1:])
        require(parts[1] == "guide" and (len(parts) > 2 or directory)
                or (not directory and rel in {QUICK_START, BUNDLE, "manifest.json"}),
                f"ZIP 含未定义条目：{name!r}")
        if not directory:
            files[rel] = item
    for name in (QUICK_START, BUNDLE, "manifest.json", *("guide/" + p for p in REQUIRED_GUIDES)):
        require(name in files and files[name].file_size > 0, f"缺少交接文件：{name}")
    return files


def verify_zip(zip_path, bundle_path):
    with zipfile.ZipFile(zip_path) as archive:
        files = archive_files(archive)
        header = files.pop("manifest.json")
        require(header.file_size <= 4 * 1024 * 1024, "manifest.json 过大")
        manifest = json.loads(archive.read(header).decode("utf-8"), object_pairs_hook=unique_object)
        require(type(manifest["formatVersion"]) is int and manifest["formatVersion"] == 1,
                "无法识别的清单格式")
        date = manifest["version"]
        require(datetime.date.fromisoformat(date).isoformat() == date, "无效的版本日期")
        refs = manifest["refs"]
        require(set(refs) == REFS and all(re.fullmatch("[0-9a-f]{40}", v) for v in refs.values()),
                "清单的四个分支或提交 ID 有误")
        require(refs["refs/heads/main"] == manifest["main"], "清单 main 与分支记录不符")
        require(type(manifest["trackedFiles"]) is int and manifest["trackedFiles"] > 0,
                "清单的跟踪文件数有误")
        require(files.keys() == manifest["files"].keys(), "ZIP 文件列表与清单不符")
        for name, item in files.items():
            with archive.open(item) as source:
                if name == BUNDLE:
                    with bundle_path.open("xb") as destination:
                        actual = digest(source, destination)
                else:
                    actual = digest(source)
            require(actual == manifest["files"][name], f"文件 SHA-256 不匹配：{name}")
    return manifest


def run(command, cwd, env):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, check=False)
    if result.returncode:
        raise ValueError(f"{' '.join(map(str, command))} 失败\n"
                         + (result.stderr or result.stdout).decode("utf-8", "replace").strip())
    return result.stdout


def verify_content(repo, tracked, manifest):
    def checked(name):
        safe_path(name)
        require(name in tracked, f"主分支缺少文件：{name}")
        return repo / name

    release = json.loads(checked("release/handoff.json").read_bytes())
    pins = {name[len("refs/heads/"):]: oid for name, oid in manifest["refs"].items()
            if name != "refs/heads/main"}
    require(release["version"] == manifest["version"] and release["archives"] == pins,
            "版本或归档分支与主分支 release/handoff.json 不符")
    start = checked("release/START-HERE.md").read_bytes().decode("utf-8")
    for token, value in (("@VERSION@", manifest["version"]), ("@MAIN@", manifest["main"]),
                         ("@FILECOUNT@", str(len(tracked)))):
        start = start.replace(token, value)
    require(hashlib.sha256(start.encode()).hexdigest() == manifest["files"][QUICK_START],
            "先读我与主分支的交接模板不符")
    for name, expected in manifest["files"].items():
        if name.startswith("guide/"):
            require(file_digest(checked(name[len("guide/"):])) == expected,
                    f"指南副本与主分支不同：{name}")
    for name in ("compose.yaml", "Dockerfile", "deploy/compose.env.example",
                 "services/sandbox/Dockerfile", "docs/PRD.md", "public/course/experiment-support.zip"):
        require(checked(name).stat().st_size > 0, f"项目文件为空：{name}")

    index = json.loads(checked("public/course/index.json").read_bytes())
    ids = {chapter["id"] for chapter in index["chapters"]}
    require(len(ids) == len(index["chapters"]) == index["assets"]["chapters"] and bool(ids),
            "课程目录的篇数或 ID 不一致")
    require({p for p in tracked if p.startswith("public/course/chapters/")} ==
            {f"public/course/chapters/{cid}.json" for cid in ids}, "课程目录与章节文件不符")
    volumes = set()
    for cid in ids:
        chapter = json.loads(checked(f"public/course/chapters/{cid}.json").read_bytes())
        require(chapter["id"] == cid and bool(chapter["blocks"]), f"章节内容无效：{cid}")
        volumes.add(chapter["volume"])
        checked("course-source/" + chapter["sourceFile"])
    require(volumes == {"upper", "lower"}, "课程缺少上册或下册")

    media = json.loads(checked("public/course/media-manifest.json").read_bytes())
    paths = set()
    total = 0
    for asset in media["assets"]:
        src = asset["src"]
        require(src.startswith("/media/") and src not in paths, f"媒体路径无效或重复：{src}")
        paths.add(src)
        path = checked("public" + src)
        size = path.stat().st_size
        require(size == asset["bytes"] and file_digest(path) == asset["sha256"],
                f"媒体校验未通过：{src}")
        total += size
    require(paths == {p[len("public"):] for p in tracked if p.startswith("public/media/")}
            and len(paths) == media["assetCount"] and paths and total == media["totalBytes"],
            "媒体文件列表、数量或大小与清单不符")
    print(f"课程与媒体已核对：{len(ids)} 篇，{len(paths)} 个媒体文件。", flush=True)


def verify_repository(work, bundle, manifest, restore_history):
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "TMPDIR") if k in os.environ}
    env.update(GIT_ALLOW_PROTOCOL="file", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_TERMINAL_PROMPT="0", GIT_ATTR_NOSYSTEM="1", LC_ALL="C")
    blank, repo = work / "empty", work / "project"

    def git(cwd, *args):
        return run(["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.autocrlf=false",
                    *args], cwd, env)

    git(work, "init", "--bare", "--template=", str(blank))
    git(blank, "bundle", "verify", str(bundle))
    heads = {}
    for line in git(blank, "bundle", "list-heads", str(bundle)).decode().splitlines():
        oid, ref = line.split()
        require(ref not in heads, f"bundle 分支重复：{ref}")
        heads[ref] = oid
    require(heads == manifest["refs"], "bundle 分支与清单记录不符")
    git(work, "clone", "--no-checkout", "--no-recurse-submodules", "--template=", "-b", "main",
        str(bundle), str(repo))
    # The clone now owns its objects. Free the temporary copy before materializing the tree.
    bundle.unlink()
    for head, oid in heads.items():
        remote = head.replace("refs/heads/", "refs/remotes/origin/", 1)
        require(git(repo, "rev-parse", remote).decode().strip() == oid, f"分支未还原：{head}")
        for entry in git(repo, "ls-tree", "-rz", oid).split(b"\0")[:-1]:
            meta, name = entry.split(b"\t", 1)
            require(meta.split()[0] in (b"100644", b"100755"), f"Git 树含链接或特殊文件：{name!r}")
            safe_path(name.decode("utf-8"))
    require(git(repo, "rev-parse", "HEAD").decode().strip() == manifest["main"], "克隆的 HEAD 不符")
    git(repo, "fsck", "--full", "--no-dangling")
    git(repo, "reset", "--hard", "--quiet", "HEAD")
    tracked = {p.decode() for p in git(repo, "ls-files", "-z").split(b"\0") if p}
    require(len(tracked) == manifest["trackedFiles"], "克隆的跟踪文件数与清单不符")
    print(f"离线克隆与 git fsck 通过：4 个分支，{len(tracked)} 个跟踪文件。", flush=True)
    verify_content(repo, tracked, manifest)
    if restore_history:
        script = repo / "scripts/restore-original-history.py"
        require(file_digest(script) == RESTORE_SHA256, "恢复脚本与已审阅版本不同，请先核对其变更")
        run([sys.executable, "-I", "-B", str(script)], repo, env)
        require(git(repo, "rev-parse", "refs/heads/course-history").decode().strip() == ORIGINAL_TIP
                and git(repo, "rev-list", "--count", ORIGINAL_TIP).strip() == b"17",
                "还原后的原始提交历史不符")
        print("已在临时克隆中恢复并核对 17 个网站原始提交。", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path, help="交接 ZIP")
    parser.add_argument("--restore-history", action="store_true", help="实际恢复并核对 17 个网站原始提交")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="zero-to-ai-handoff-") as tmp:
        work = Path(tmp).resolve()
        bundle = work / BUNDLE
        manifest = verify_zip(args.zip, bundle)
        print(f"ZIP 文件路径与 SHA-256 已核对，版本 {manifest['version']}。", flush=True)
        verify_repository(work, bundle, manifest, args.restore_history)
        print(f"交接包验证通过。main {manifest['main']}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError,
            zipfile.BadZipFile) as error:
        sys.exit(f"交接包验证失败：{error}")
