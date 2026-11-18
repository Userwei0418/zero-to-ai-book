"""Build the offline reader/developer handoff from committed public Git objects."""
import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "zero-to-ai-book-handoff/"
ARCHIVES = {"archive/original-history", "archive/site-history", "archive/source-snapshot"}


def git(*args, cwd=ROOT, env=None):
    return subprocess.check_output(["git", *args], cwd=cwd, env=env)


def sha256_file(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def public_refs(main, archives):
    if not isinstance(archives, dict) or set(archives) != ARCHIVES:
        raise ValueError("Expected the three documented public archive branches")
    refs = {"refs/heads/main": main}
    for name, sha in sorted(archives.items()):
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError(f"Invalid pinned commit for {name}")
        if git("rev-parse", "--verify", sha + "^{commit}").decode().strip() != sha:
            raise ValueError(f"Missing archive commit for {name}; use a full clone")
        refs["refs/heads/" + name] = sha
    return refs


def write_bundle(directory, refs):
    storage = directory / "refs.git"
    git("init", "--bare", "--quiet", str(storage))
    objects = git("rev-parse", "--path-format=absolute", "--git-path", "objects").decode().strip()
    # Expose existing objects for reading. Only explicit, published refs are pack roots.
    env = dict(os.environ, GIT_ALTERNATE_OBJECT_DIRECTORIES=objects, GIT_NO_REPLACE_OBJECTS="1")
    for name, sha in refs.items():
        git("update-ref", name, sha, cwd=storage, env=env)
    bundle = directory / "history.bundle"
    git("-c", "pack.threads=2", "-c", "pack.windowMemory=128m", "bundle", "create",
        "--version=2", str(bundle), *refs, cwd=storage, env=env)
    return bundle


def zip_entry(name):
    entry = ZipInfo(PREFIX + name, (1980, 1, 1, 0, 0, 0))
    entry.create_system = 3
    entry.external_attr = 0o100644 << 16
    entry.compress_type = ZIP_DEFLATED if name.endswith((".md", ".json")) else ZIP_STORED
    return entry


def add_bytes(archive, hashes, name, data):
    archive.writestr(zip_entry(name), data)
    hashes[name] = hashlib.sha256(data).hexdigest()


def build(output):
    main = git("rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    snapshot = json.loads(git("show", main + ":release/handoff.json"))
    version = snapshot["version"]
    if date.fromisoformat(version).isoformat() != version:
        raise ValueError("Expected a YYYY-MM-DD handoff version")
    refs = public_refs(main, snapshot["archives"])
    files = git("ls-tree", "-rz", "--name-only", main).decode().rstrip("\0").split("\0")
    start = git("show", main + ":release/START-HERE.md").decode()
    for key, value in {"@MAIN@": main, "@VERSION@": version, "@FILECOUNT@": str(len(files))}.items():
        start = start.replace(key, value)
    name = "zero-to-ai-book-handoff-" + version + ".zip"
    output.mkdir(parents=True, exist_ok=True)
    if (output / name).exists() or (output / "SHA256SUMS.txt").exists():
        raise FileExistsError("Choose an empty output directory to preserve earlier artifacts")
    with tempfile.TemporaryDirectory(prefix=".build-", dir=output) as temp:
        directory = Path(temp).resolve()
        bundle = write_bundle(directory, refs)
        hashes = {}
        with ZipFile(directory / name, "w", allowZip64=True) as archive:
            add_bytes(archive, hashes, "00-先读我.md", start.encode())
            with bundle.open("rb") as source, archive.open(zip_entry("history.bundle"), "w", force_zip64=True) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            hashes["history.bundle"] = sha256_file(bundle)
            # The small browseable guide accompanies the full, offline clone.
            for path in files:
                if path == "README.md" or path.startswith("docs/"):
                    add_bytes(archive, hashes, "guide/" + path, git("show", main + ":" + path))
            manifest = {"formatVersion": 1, "version": version, "main": main, "refs": refs,
                        "trackedFiles": len(files), "files": hashes}
            archive.writestr(zip_entry("manifest.json"),
                             json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
        digest = sha256_file(directory / name)
        (directory / "SHA256SUMS.txt").write_text(f"{digest}  {name}\n", encoding="ascii")
        for item in (name, "SHA256SUMS.txt"):
            (directory / item).rename(output / item)
        print(f"{output / name} ({(output / name).stat().st_size:,} bytes, {len(files)} tracked files)")
        print(f"SHA-256 {digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    build(parser.parse_args().output_dir.resolve())
