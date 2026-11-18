#!/usr/bin/env python3
"""Build small responsive reading images and instant-start video containers.

Run after import-course.py (no legacy lossless optimization pass is needed):
    python scripts/prepare-media-delivery.py
Verify the generated delivery set without encoding:
    python scripts/prepare-media-delivery.py --verify

Requires Pillow with WebP support, ffmpeg and ffprobe. Small images (<=256 KiB)
remain byte-identical full-size originals. Larger images use full-size WebP q94;
all raster images get a <=960px WebP q90 reading variant. This is intentionally
high-quality lossy delivery, not a claim of pixel-identical image preservation.
Videos are stream-copied with moov at the front; every encoded packet is hashed
before/after. Existing manifests prevent lossy-to-lossy re-encoding. Original
source bytes can be recovered from the recorded source Git revision.
"""
from __future__ import annotations
import argparse, hashlib, io, json, re, subprocess, sys, tempfile
from pathlib import Path
from xml.etree import ElementTree
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
COURSE = ROOT / 'public/course'
MEDIA = ROOT / 'public/media'
MANIFEST = COURSE / 'media-delivery.json'
MEDIA_FIELDS = {'src', 'width', 'height', 'previewSrc', 'previewWidth', 'previewHeight', 'srcSet', 'poster', 'duration'}
MIB = 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def dump(path, data):
    encoded = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if not path.exists() or path.read_text() != encoded:
        path.write_text(encoded)


def public_path(src):
    assert src.startswith('/media/') and '/' not in src[len('/media/'):], src
    return ROOT / 'public' / src.lstrip('/')


def media_fields(record):
    return {key: record[key] for key in MEDIA_FIELDS if key in record}


def content_digest(chapters):
    clean = json.loads(json.dumps(chapters, ensure_ascii=False))
    for chapter in clean.values():
        for block in chapter['blocks']:
            if block['type'] in ('image', 'video'):
                for key in MEDIA_FIELDS:
                    block.pop(key, None)
    return sha(json.dumps(clean, ensure_ascii=False, sort_keys=True).encode())


def asset(src, data=None):
    data = public_path(src).read_bytes() if data is None else data
    return {'src': src, 'bytes': len(data), 'sha256': sha(data)}


def write_asset(data, suffix):
    src = '/media/' + sha(data)[:24] + suffix
    path = public_path(src)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)
    return asset(src, data)


def encode_webp(im, quality):
    output = io.BytesIO()
    options = dict(format='WEBP', quality=quality, method=4, exact=True)
    for name in ('icc_profile', 'exif'):
        if im.info.get(name):
            options[name] = im.info[name]
    im.save(output, **options)
    return output.getvalue()


def image_record(src, data, revision, aliases):
    base = {'kind': 'image', 'source': asset(src, data), 'sourceGitRevision': revision, 'aliases': aliases}
    # Rebuilding from Git also restores byte-identical small originals / SVG.
    if not public_path(src).exists():
        public_path(src).write_bytes(data)
    if src.endswith('.svg'):
        root = ElementTree.fromstring(data)
        box = re.split(r'[ ,]+', root.attrib.get('viewBox', '0 0 1200 540'))
        width, height = int(float(box[2])), int(float(box[3]))
        return {**base, 'src': src, 'width': width, 'height': height, 'encoding': 'original-svg', 'assets': [asset(src, data)]}
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        width, height = im.size
        if len(data) > 256 * 1024:
            full = write_asset(encode_webp(im, 94), '.webp')
            encoding = 'full-size-webp-quality-94'
            # Never replace a source by a larger encoding.
            if full['bytes'] >= len(data):
                public_path(full['src']).unlink()
                full = asset(src, data)
                encoding = 'original-smaller-than-webp'
        else:
            full = asset(src, data)
            encoding = 'byte-identical-original'
        preview = im.copy()
        preview.thumbnail((960, 960), Image.Resampling.LANCZOS)
        preview_asset = write_asset(encode_webp(preview, 90), '.webp')
        # Keep the original as the only candidate if it is already more compact.
        if preview_asset['bytes'] >= full['bytes']:
            if preview_asset['src'] != full['src']:
                public_path(preview_asset['src']).unlink()
            preview_asset = full
            preview_width, preview_height = width, height
        else:
            preview_width, preview_height = preview.size
        srcset = f"{preview_asset['src']} {preview_width}w"
        assets = [full]
        if preview_asset['src'] != full['src']:
            assets.append(preview_asset)
            if preview_width < width:
                srcset += f", {full['src']} {width}w"
        return {**base, 'src': full['src'], 'width': width, 'height': height,
                'previewSrc': preview_asset['src'], 'previewWidth': preview_width,
                'previewHeight': preview_height, 'srcSet': srcset,
                'encoding': encoding, 'assets': assets}


def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE)


def packet_hash(path):
    # Encoded packet payloads, in demux order: no frame/audio re-encoding allowed.
    return sha(run(['ffprobe', '-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
                    '-show_entries', 'packet=stream_index,data_hash', '-of', 'csv=p=0', str(path)]))


def atom_positions(data):
    result = {}
    offset = 0
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset+4], 'big')
        kind = data[offset+4:offset+8].decode('ascii', errors='replace')
        if size == 1:
            size = int.from_bytes(data[offset+8:offset+16], 'big')
        elif size == 0:
            size = len(data) - offset
        if size < 8:
            raise ValueError('Invalid MP4 atom')
        result[kind] = offset
        offset += size
    return result


def video_record(src, data, revision, aliases):
    with tempfile.TemporaryDirectory(prefix='course-video-') as directory:
        source = Path(directory) / 'source.mp4'
        output = Path(directory) / 'faststart.mp4'
        source.write_bytes(data)
        packet_before = packet_hash(source)
        before = atom_positions(data)
        if before['moov'] < before['mdat']:
            encoded = data
        else:
            run(['ffmpeg', '-v', 'error', '-i', str(source), '-map', '0', '-c', 'copy',
                 '-movflags', '+faststart', '-y', str(output)])
            encoded = output.read_bytes()
            assert packet_hash(output) == packet_before, 'Encoded video/audio packet mismatch: ' + src
        after = atom_positions(encoded)
        assert after['moov'] < after['mdat'], 'Video is not faststart: ' + src
        info = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(source)]))
        stream = next(s for s in info['streams'] if s['codec_type'] == 'video')
        duration = round(float(info['format']['duration']), 3)
        poster_data = run(['ffmpeg', '-v', 'error', '-ss', str(min(0.5, duration / 3)), '-i', str(source),
                           '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'])
        with Image.open(io.BytesIO(poster_data)) as poster:
            poster.thumbnail((960, 960), Image.Resampling.LANCZOS)
            poster_asset = write_asset(encode_webp(poster, 85), '.webp')
        full = write_asset(encoded, '.mp4')
        return {'kind': 'video', 'source': asset(src, data), 'sourceGitRevision': revision, 'aliases': aliases,
                'src': full['src'], 'width': stream['width'], 'height': stream['height'],
                'poster': poster_asset['src'], 'duration': duration, 'encoding': 'stream-copy-faststart',
                'packetSha256': packet_before, 'allEncodedPacketsIdentical': True,
                'sourceMoovOffset': before.get('moov'), 'moovOffset': after['moov'], 'mdatOffset': after['mdat'],
                'assets': [full, poster_asset]}


def outputs_valid(record):
    return all(public_path(a['src']).is_file() and asset(a['src']) == a for a in record['assets'])


def source_bytes(record):
    original = record['source']
    path = public_path(original['src'])
    data = path.read_bytes() if path.exists() else run(['git', '-C', str(ROOT), 'show', record['sourceGitRevision'] + ':public' + original['src']])
    assert sha(data) == original['sha256'], 'Original source changed: ' + original['src']
    return data


def verify(chapters, report):
    by_output = {record['src']: record for record in report['records']}
    count = 0
    for chapter in chapters.values():
        for block in chapter['blocks']:
            if block['type'] not in ('image', 'video') or not block.get('src'):
                continue
            record = by_output[block['src']]
            for field, value in media_fields(record).items():
                assert block.get(field) == value, f"Media metadata mismatch: {block['id']} {field}"
            count += 1
    for record in report['records']:
        assert outputs_valid(record), 'Asset checksum mismatch: ' + record['src']
        if record['kind'] == 'video':
            data = public_path(record['src']).read_bytes()
            positions = atom_positions(data)
            assert positions['moov'] < positions['mdat']
            assert packet_hash(public_path(record['src'])) == record['packetSha256']
    assert content_digest(chapters) == report['courseContentSha256'], 'Lesson content changed'
    print(json.dumps({'mediaReferencesVerified': count, 'assetsVerified': sum(len(r['assets']) for r in report['records']),
                      'faststartVideosVerified': sum(r['kind'] == 'video' for r in report['records']),
                      'courseContentUnchanged': True}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    assert features.check('webp'), 'Pillow WebP support is required'
    subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-cover-delivery.py'), *(['--verify'] if args.verify else [])], check=True)
    chapters = {p.name: json.loads(p.read_text()) for p in sorted((COURSE / 'chapters').glob('*.json'))}
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else None
    if args.verify:
        assert previous, 'Run preparation first'
        verify(chapters, previous)
        return
    content_before = content_digest(chapters)
    untouched = {p: sha(p.read_bytes()) for p in [COURSE / 'pyodide-validation.json', ROOT / 'lib/generated/course-context.json'] if p.exists()}
    before_files = {p.name: p.stat().st_size for p in MEDIA.iterdir() if p.is_file()}
    revision = run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip()
    old_by_src = {}
    for record in (previous or {}).get('records', []):
        for name in [record['src'], record['source']['src'], *(a['src'] for a in record.get('aliases', []))]:
            old_by_src[name] = record
    legacy_path = COURSE / 'media-optimization.json'
    legacy = json.loads(legacy_path.read_text()) if legacy_path.exists() else {}
    aliases_by_src = {}
    for record in legacy.get('conversions', []):
        aliases_by_src[record['replacement']] = [{'src': record['original'], 'sha256': record['pngSha256'], 'bytes': record['pngBytes']}]
    sources = sorted({b['src'] for c in chapters.values() for b in c['blocks'] if b['type'] in ('image', 'video') and b.get('src')})
    records, mapping = [], {}
    for index, src in enumerate(sources):
        existing = old_by_src.get(src)
        if existing and outputs_valid(existing):
            # A freshly imported alias must match its old source; never reuse a
            # preview when an author has replaced that source image in-place.
            expected = next((a for a in [existing['source'], *existing.get('aliases', [])] if a['src'] == src), None)
            if expected and public_path(src).exists():
                assert asset(src) == expected, 'Source changed; remove its delivery manifest record to regenerate: ' + src
            record = existing
        else:
            data = source_bytes(existing) if existing else public_path(src).read_bytes()
            source = existing['source']['src'] if existing else src
            source_revision = existing['sourceGitRevision'] if existing else revision
            aliases = existing.get('aliases', []) if existing else aliases_by_src.get(src, [])
            record = (video_record if source.endswith('.mp4') else image_record)(source, data, source_revision, aliases)
        records.append(record)
        mapping[src] = media_fields(record)
        if (index + 1) % 25 == 0 or index + 1 == len(sources):
            print(f"Prepared {index + 1}/{len(sources)} media sources", flush=True)
    for chapter in chapters.values():
        for block in chapter['blocks']:
            if block['type'] in ('image', 'video') and block.get('src'):
                block.update(mapping[block['src']])
    assert content_digest(chapters) == content_before, 'Lesson content changed'
    for path, digest in untouched.items():
        assert sha(path.read_bytes()) == digest, 'Unrelated generated artifact changed: ' + str(path)
    records.sort(key=lambda record: record['source']['src'])
    keep = {a['src'] for record in records for a in record['assets']}
    # The manifest contains every local course media reference, so replaced
    # originals may be removed from deployment without deleting source history.
    for path in MEDIA.iterdir():
        if path.is_file() and '/media/' + path.name not in keep:
            path.unlink()
    current_assets = [asset(src) for src in sorted(keep)]
    total = sum(a['bytes'] for a in current_assets)
    rasters = [r for r in records if r['kind'] == 'image' and not r['src'].endswith('.svg')]
    original_images = sum(r['source']['bytes'] for r in rasters)
    preview_bytes = [next(a['bytes'] for a in r['assets'] if a['src'] == r['previewSrc']) for r in rasters]
    summary = {'sourceMediaBytes': sum(r['source']['bytes'] for r in records), 'totalMediaBytes': total,
               'sourceRasterImageBytes': original_images,
               'deliveredRasterImageBytes': sum(a['bytes'] for r in rasters for a in r['assets']),
               'readingPreviewBytes': sum(preview_bytes), 'readingPreviewMedianBytes': sorted(preview_bytes)[len(preview_bytes)//2],
               'readingPreviewP95Bytes': sorted(preview_bytes)[int(len(preview_bytes)*.95)],
               'readingPreviewMaxBytes': max(preview_bytes),
               'fullSizeImagesPreservedByteForByte': sum(r['encoding'] == 'byte-identical-original' for r in rasters),
               'fullSizeHighQualityWebpImages': sum(r['encoding'] == 'full-size-webp-quality-94' for r in rasters),
               'faststartVideos': sum(r['kind'] == 'video' for r in records)}
    report = {'version': 1, 'updatedAt': '2026-11-18',
              'method': 'Small originals preserved; larger full-resolution WebP q94 + <=960px WebP q90 previews; video stream-copy faststart + click-to-load poster.',
              'courseContentSha256': content_before, 'courseContentUnchanged': True,
              'sourceRecovery': 'Original paths and SHA256 hashes are recorded below; missing originals can be restored with git show SOURCE_REVISION:public/SOURCE_PATH. Do not recompress generated WebP variants.',
              'summary': summary, 'records': records}
    for filename, chapter in chapters.items():
        dump(COURSE / 'chapters' / filename, chapter)
    dump(MANIFEST, report)
    dump(COURSE / 'media-manifest.json', {'updatedAt': '2026-11-18', 'assetCount': len(current_assets), 'totalBytes': total, 'assets': current_assets})
    index = json.loads((COURSE / 'index.json').read_text())
    index['assets'].update({'mediaBytes': total, 'mediaSavedBytes': summary['sourceMediaBytes'] - total,
                            'readingPreviewBytes': summary['readingPreviewBytes'], 'faststartVideos': summary['faststartVideos'],
                            'losslessWebpImages': 0, 'highQualityWebpImages': summary['fullSizeHighQualityWebpImages']})
    dump(COURSE / 'index.json', index)
    if legacy:
        legacy['historicalReport'] = True
        legacy['supersededBy'] = '/course/media-delivery.json'
        dump(legacy_path, legacy)
    verify(chapters, report)
    new_assets = [a for a in current_assets if Path(a['src']).name not in before_files]
    print(json.dumps({**summary, 'newAssetsBytes': sum(a['bytes'] for a in new_assets),
                      'newImageAssetsBytes': sum(a['bytes'] for a in new_assets if not a['src'].endswith('.mp4')),
                      'deployMediaMiB': round(total / MIB, 2)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
