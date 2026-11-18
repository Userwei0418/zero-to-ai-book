"""Recover the unmodified 18-commit project history from the archive branch."""
import hashlib
import subprocess
import sys
import tempfile

ARCHIVE = "refs/remotes/origin/archive/original-history"
BASE_TREE = "4ac707cca0c58a7ac122151ffa137233320569f4"
TIP = "a3268fa0902fcddee8a3503689e33b1ffdd981d2"
DIGEST = "37cee5858895b3452c37cba58807c0f188b9eff9bb9fb50ff770fbb8073af87b"
BRANCH = "refs/heads/course-history"


def git(*args):
    return subprocess.check_output(["git", *args])


def exists(obj):
    return subprocess.run(["git", "cat-file", "-e", obj], stderr=subprocess.DEVNULL).returncode == 0


def main():
    git("rev-parse", "--git-dir")
    if not exists(BASE_TREE):
        sys.exit("缺少原始文件树。请获取 archive/source-snapshot 分支，然后重试。")
    if not exists(TIP + "^{commit}"):
        if not exists(ARCHIVE):
            subprocess.run(["git", "fetch", "origin", f"refs/heads/archive/original-history:{ARCHIVE}"], check=True)
        paths = git("ls-tree", "-r", "--name-only", ARCHIVE, "--", "parts").decode().splitlines()
        if not paths:
            sys.exit("历史归档缺少分片。")
        with tempfile.TemporaryFile() as pack:
            digest = hashlib.sha256()
            for path in sorted(paths):
                data = git("show", f"{ARCHIVE}:{path}")
                digest.update(data)
                pack.write(data)
            if digest.hexdigest() != DIGEST:
                sys.exit("历史归档 SHA-256 校验失败。请重新获取归档分支。")
            pack.seek(0)
            subprocess.run(["git", "index-pack", "--stdin", "--fix-thin"], stdin=pack, check=True)
    git("fsck", "--connectivity-only", "--no-dangling", TIP)
    if git("rev-list", "--count", TIP).strip() != b"18":
        sys.exit("原始提交数量与交接记录不符。")
    if exists(BRANCH):
        if git("rev-parse", BRANCH).decode().strip() != TIP:
            sys.exit("本地 course-history 已指向其他提交，请先保留或重命名该分支。")
    else:
        git("update-ref", BRANCH, TIP, "")
    print("已恢复 18 个原始提交。运行 git log --oneline course-history 可查看。")


if __name__ == "__main__":
    main()
