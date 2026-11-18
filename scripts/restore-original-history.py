"""Restore the published site history, or rebuild an isolated author checkout."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SNAPSHOT = "refs/remotes/origin/archive/source-snapshot"
SITE_ARCHIVE = "refs/remotes/origin/archive/site-history"
AUTHOR_ARCHIVE = "refs/remotes/origin/archive/original-history"
PUBLIC_TREE = "ef2e691471713cdd40507f2a0d097048a252dcfe"
SITE_TIP = "d0fa0881e575f37fbbcf8b0d49f3f0d75b07aede"
SITE_DIGEST = "56fa771a195aadc7859e708ff29f134a608a54f73bd41a6c5ed85f35f4d1cdc8"
AUTHOR_TREE = "4ac707cca0c58a7ac122151ffa137233320569f4"
AUTHOR_TIP = "a3268fa0902fcddee8a3503689e33b1ffdd981d2"
AUTHOR_DIGEST = "37cee5858895b3452c37cba58807c0f188b9eff9bb9fb50ff770fbb8073af87b"
COMPANION_PATH = "course-source/attachments/mygpt-companion-20261117-r4-8c90a8fb.zip"
COMPANION_DIGEST = "8c90a8fbe5f73bb3cea1186176c59f0044e260fe8f9a5e8ddc3013f5ce9a9e1a"


def git(*args, cwd=None, **kwargs):
    return subprocess.check_output(["git", *args], cwd=cwd, **kwargs)


def exists(obj):
    return subprocess.run(["git", "cat-file", "-e", obj], stderr=subprocess.DEVNULL).returncode == 0


def unpack_history(ref, expected, destination, *, thin=False, env=None):
    paths = git("ls-tree", "-r", "--name-only", ref, "--", "parts", env=env).decode().splitlines()
    if not paths:
        sys.exit("历史归档缺少分片。")
    with tempfile.TemporaryFile() as pack:
        digest = hashlib.sha256()
        for path in sorted(paths):
            data = git("show", f"{ref}:{path}", env=env)
            digest.update(data)
            pack.write(data)
        if digest.hexdigest() != expected:
            sys.exit("历史归档 SHA-256 校验失败。请重新获取归档分支。")
        pack.seek(0)
        args = ["index-pack", "--stdin"]
        if thin:
            args.append("--fix-thin")
        git(*args, cwd=destination, stdin=pack, env=env)


def verify_chain(directory, tip, count, env=None):
    git("fsck", "--connectivity-only", "--no-dangling", tip, cwd=directory, env=env)
    if int(git("rev-list", "--count", tip, cwd=directory, env=env)) != count:
        sys.exit("原始提交数量与交接记录不符。")


def restore_site():
    git("rev-parse", "--git-dir")
    if not exists(PUBLIC_TREE):
        sys.exit("缺少原始文件树。请获取 archive/source-snapshot 分支，然后重试。")
    if not exists(SITE_TIP + "^{tree}"):
        if not exists(SITE_ARCHIVE):
            git("fetch", "origin", f"refs/heads/archive/site-history:{SITE_ARCHIVE}")
        unpack_history(SITE_ARCHIVE, SITE_DIGEST, None)
    verify_chain(None, SITE_TIP, 17)
    branch = "refs/heads/course-history"
    if exists(branch):
        if git("rev-parse", branch).decode().strip() != SITE_TIP:
            sys.exit("本地 course-history 已指向其他提交，请先保留或重命名该分支。")
    else:
        git("update-ref", branch, SITE_TIP, "")
    print("已恢复 17 个网站原始提交。运行 git log --oneline course-history 可查看。")


def restore_author(companion, destination):
    # A caller may have set GIT_DIR, GIT_INDEX_FILE or alternate object stores.
    # The private blob must be written exclusively to the new repository.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_ALLOW_PROTOCOL="file", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    source = Path(os.fsdecode(git("rev-parse", "--show-toplevel", env=env)).strip()).resolve()
    target = destination.expanduser().absolute()
    if target.is_symlink() or target.exists():
        sys.exit("目标目录已经存在。请选择一个新目录。")
    target = target.resolve()
    if target == source or source in target.parents:
        sys.exit("请在公开工作树以外选择新的作者目录。")
    if not target.parent.is_dir():
        sys.exit("目标目录的上一级必须已经存在。")
    with companion.expanduser().open("rb") as stream:
        content = stream.read(1_869_423 + 1)
    if hashlib.sha256(content).hexdigest() != COMPANION_DIGEST:
        sys.exit("附件 SHA-256 不匹配，请使用作者保管的原始 ZIP。")
    for ref in (SNAPSHOT, AUTHOR_ARCHIVE):
        if subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                          stdout=subprocess.DEVNULL, env=env).returncode:
            sys.exit(f"本地缺少 {ref}，请按交接指南先获取两个公开归档分支。")
    if git("rev-parse", SNAPSHOT + "^{tree}", env=env).decode().strip() != PUBLIC_TREE:
        sys.exit("公开原稿快照校验失败。")

    with tempfile.TemporaryDirectory(prefix=".course-restore-", dir=target.parent) as temp:
        project = Path(temp) / "book"
        git("init", "--quiet", "--template=", "--initial-branch=main", str(project), env=env)
        git("fetch", "--quiet", "--no-tags", "--no-write-fetch-head", str(source), SNAPSHOT,
            cwd=project, env=env)
        git("read-tree", PUBLIC_TREE, cwd=project, env=env)
        blob = git("hash-object", "-w", "--stdin", input=content, cwd=project, env=env).decode().strip()
        git("update-index", "--add", "--cacheinfo", f"100644,{blob},{COMPANION_PATH}",
            cwd=project, env=env)
        if git("write-tree", cwd=project, env=env).decode().strip() != AUTHOR_TREE:
            sys.exit("合并附件后的作者文件树校验失败。")
        unpack_history(AUTHOR_ARCHIVE, AUTHOR_DIGEST, project, thin=True, env=env)
        verify_chain(project, AUTHOR_TIP, 18, env)
        git("update-ref", "refs/heads/main", AUTHOR_TIP, "", cwd=project, env=env)
        git("reset", "--hard", "--quiet", "HEAD", cwd=project, env=env)
        if git("status", "--porcelain", cwd=project, env=env) or git("remote", cwd=project, env=env):
            sys.exit("作者工作树或远端配置校验失败。")
        target.mkdir(mode=0o700)
        project.chmod(0o700)
        project.replace(target)
    print(f"已在 {target} 还原 18 个原始提交，HEAD 为 {AUTHOR_TIP}。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-companion", type=Path, help="作者保管的原始 ZIP")
    parser.add_argument("--destination", type=Path, help="公开工作树以外的新目录")
    args = parser.parse_args()
    if (args.private_companion is None) != (args.destination is None):
        parser.error("--private-companion 和 --destination 必须同时指定")
    if args.private_companion is not None:
        restore_author(args.private_companion, args.destination)
    else:
        restore_site()


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
