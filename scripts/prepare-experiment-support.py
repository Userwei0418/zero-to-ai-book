"""Build the reader's download-only support bundle using only published course content."""
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1] / "public/course"
chapters = [json.loads(path.read_text()) for path in sorted((ROOT / "chapters").glob("*.json"))]
entries = {}
previous = {}

for chapter in chapters:
    if chapter["volume"] == "upper":
        # Give lower-volume indexing exercises the same published material as the reader.
        paragraphs = []
        for block in chapter["blocks"]:
            if block["type"] == "heading":
                paragraphs.append("#" * max(1, min(6, block.get("level", 1))) + " " + block["text"])
            elif block["type"] == "code":
                paragraphs.append(f'```{block.get("language", "")}\n{block.get("code", "")}\n```')
            elif block.get("text"):
                paragraphs.append(block["text"])
        entries[chapter["sourceFile"]] = "\n\n".join(paragraphs) + "\n"
    elif re.fullmatch(r"lower-\d\d", chapter["id"]):
        files = chapter.get("files", {})
        named = {block.get("filename") for block in chapter["blocks"] if block["type"] == "code"}
        own = {name for name, value in files.items() if name in named or previous.get(name) != value}
        for name in sorted(own):
            # cli.py and count_kb.py have flat reader aliases; preserve their actual module path.
            if "/" not in name and any(other.endswith("/" + name) for other in own):
                continue
            entries[f'下册/课件/ch{chapter["id"][-2:]}/{name}'] = files[name]
        previous.update(files)

target = ROOT / "experiment-support.zip"
with ZipFile(target, "w") as archive:
    for name, content in sorted(entries.items()):
        assert not name.startswith("/") and ".." not in Path(name).parts
        info = ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, content.encode("utf-8"))
