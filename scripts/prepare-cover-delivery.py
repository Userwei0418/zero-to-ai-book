#!/usr/bin/env python3
"""Create an original-size high-quality WebP cover, with repeatable verification.

The source PNG is recoverable from the revision in public/assets/asset-manifest.json.
Run directly or through scripts/prepare-media-delivery.py; --verify never encodes.
"""
from __future__ import annotations
import argparse, hashlib, io, json, subprocess
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'public/assets'
MANIFEST = DIRECTORY / 'asset-manifest.json'
READER = ROOT / 'components/book-reader.tsx'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def public_path(src):
    assert src.startswith('/assets/') and '/' not in src[len('/assets/'):]
    return ROOT / 'public' / src.lstrip('/')


def verify(report):
    cover = report['cover']
    data = public_path(cover['src']).read_bytes()
    assert sha(data) == cover['sha256'] and len(data) == cover['bytes'], 'Cover checksum mismatch'
    with Image.open(io.BytesIO(data)) as im:
        assert im.size == (cover['width'], cover['height']), 'Cover dimensions changed'
    assert f'src="{cover["src"]}"' in READER.read_text(), 'Reader cover reference is stale'
    print(json.dumps({'coverVerified': True, 'sourceBytes': report['source']['bytes'], 'coverBytes': cover['bytes'],
                      'coverSrc': cover['src']}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else None
    if args.verify:
        assert previous, 'Run cover preparation first'
        verify(previous)
        return
    if previous and public_path(previous['cover']['src']).exists():
        verify(previous)
        return
    source = previous['source'] if previous else {
        'src': '/assets/book-cover.png',
        'gitRevision': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip()}
    path = public_path(source['src'])
    data = path.read_bytes() if path.exists() else subprocess.check_output([
        'git', '-C', str(ROOT), 'show', source['gitRevision'] + ':public' + source['src']])
    if previous:
        assert sha(data) == source['sha256'], 'Original cover changed'
    source.update({'bytes': len(data), 'sha256': sha(data)})
    with Image.open(io.BytesIO(data)) as im:
        output = io.BytesIO()
        options = {'format': 'WEBP', 'quality': 94, 'method': 4, 'exact': True}
        for field in ('icc_profile', 'exif'):
            if im.info.get(field):
                options[field] = im.info[field]
        im.save(output, **options)
        encoded = output.getvalue()
        assert len(encoded) < len(data), 'Cover output is not smaller'
        src = '/assets/book-cover-' + sha(encoded)[:16] + '.webp'
        public_path(src).write_bytes(encoded)
        report = {'version': 1, 'method': 'Original 1024x1536 dimensions; WebP quality 94; no crop or semantic change.',
                  'source': source, 'cover': {'src': src, 'bytes': len(encoded), 'sha256': sha(encoded), 'width': im.width, 'height': im.height}}
    # Exactly the cover src is changed; the reader's pagination and behavior stay intact.
    reader = READER.read_text()
    old = previous['cover']['src'] if previous else source['src']
    needle = f'src="{old}"'
    if needle in reader:
        assert reader.count(needle) == 1, 'Unexpected duplicate cover references'
        READER.write_text(reader.replace(needle, f'src="{src}"'))
    else:
        assert f'src="{src}"' in reader, 'Cover reference not found'
    MANIFEST.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if path.exists() and path != public_path(src):
        path.unlink()
    verify(report)


if __name__ == '__main__':
    main()
