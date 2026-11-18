#!/usr/bin/env python3
"""Prepare the exact offline assets used by the real Notebook and course tests."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import sys
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

VERSION = "0.27.7"
BASE_URL = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/"
# SHA-256 of the versioned Pyodide release used in the course validation report.
RUNTIME = {
    "pyodide-lock.json": "9c45b916001a750f4102fc287494f3eab215909c7535c626a20db80fd6333e2c",
    "pyodide.js": "b4cb23a53aba19c221659b9fb40a2f18281d685691dc06647fb0afd0681baf98",
    "pyodide.asm.js": "6b4c90de5b7172873f04f21884d0e9d2274e305fe32116558fe3e4fbe3618d51",
    "pyodide.asm.wasm": "a50dd1843f805a0b7c45b61037ee0d7b26dfe85efe0e18ef95a34ad24e401f5f",
    "python_stdlib.zip": "16611534726e5d8ac2bd8f926410b2dcb8d6f49aa24913463533b457a2115c16",
}


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def ensure_file(directory, name, sha256):
    path = directory / name
    if path.is_file() and digest(path) == sha256:
        return
    with NamedTemporaryFile(dir=directory, delete=False) as dst:
        temporary = Path(dst.name)
    try:
        with urlopen(BASE_URL + name, timeout=90) as response, temporary.open("wb") as dst:
            shutil.copyfileobj(response, dst)
        if digest(temporary) != sha256:
            raise ValueError(f"{name}: downloaded bytes differ from the pinned SHA-256")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    # The main project uses ES modules, but these two release loaders use CommonJS.
    manifest = directory / "package.json"
    if manifest.exists():
        if json.loads(manifest.read_text()).get("type", "commonjs") != "commonjs":
            raise ValueError(f"{directory} belongs to an ES modules package; use a dedicated cache")
    else:
        with manifest.open("x") as file:
            file.write('{"private":true,"type":"commonjs"}\n')
    lock = "pyodide-lock.json"
    ensure_file(directory, lock, RUNTIME[lock])
    packages = json.loads((directory / lock).read_text())["packages"]
    files = {name: sha for name, sha in RUNTIME.items() if name != lock}
    pending = ["pandas", "matplotlib"]
    while pending:
        package = packages[pending.pop()]
        name = package["file_name"]
        if name not in files:
            files[name] = package["sha256"]
            pending.extend(package["depends"])
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = [pool.submit(ensure_file, directory, name, sha) for name, sha in files.items()]
        for task in tasks:
            task.result()
    print(f"Pyodide {VERSION}: verified {len(files) + 1} release files in {directory.resolve()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(".sites-runtime/pyodide-test"),
                        help="dedicated runtime cache, relative to the current working directory")
    try:
        prepare(parser.parse_args().directory)
    except (OSError, ValueError) as error:
        sys.exit(f"Pyodide preparation failed: {error}")
