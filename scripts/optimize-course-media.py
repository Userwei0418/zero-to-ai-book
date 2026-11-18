#!/usr/bin/env python3
"""Publish-size repair: convert only enough large PNGs to pixel-identical WebP.

Run after scripts/import-course.py:
    python scripts/optimize-course-media.py
Requires Pillow with WebP support. Original source PNGs remain in review_source.
The saved manifest makes repeated execution and a fresh import reproducible.
No prose, code, chapter.files, videos, block IDs or Pyodide results are rewritten.
"""
from __future__ import annotations
import argparse, hashlib, json, re, tempfile
from pathlib import Path
from PIL import Image, features

ROOT=Path(__file__).resolve().parents[1]
MEDIA=ROOT/'public/media'
COURSE=ROOT/'public/course'
MANIFEST=COURSE/'media-optimization.json'
MIB=1024*1024

def sha(data):return hashlib.sha256(data).hexdigest()
def file_sha(path):return sha(path.read_bytes())
def dump(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
def media_bytes():return sum(p.stat().st_size for p in MEDIA.iterdir() if p.is_file())
def content_digest(chapters):
    # Compare absolutely everything except the specific image src fields.
    clean=json.loads(json.dumps(chapters,ensure_ascii=False))
    for chapter in clean.values():
        for block in chapter['blocks']:
            if block['type']=='image':block.pop('src',None)
    return sha(json.dumps(clean,ensure_ascii=False,sort_keys=True).encode())

def convert(path):
    with Image.open(path) as original:
        rgba=original.convert('RGBA');raw=rgba.tobytes()
        profile=original.info.get('icc_profile',b'');exif=original.info.get('exif',b'')
        options={'format':'WEBP','lossless':True,'quality':75,'method':4,'exact':True}
        if profile:options['icc_profile']=profile
        if exif:options['exif']=exif
        with tempfile.NamedTemporaryFile(suffix='.webp') as tmp:
            rgba.save(tmp.name,**options)
            encoded=Path(tmp.name).read_bytes()
            with Image.open(tmp.name) as decoded:
                assert decoded.size==rgba.size and decoded.convert('RGBA').tobytes()==raw, 'RGBA mismatch: '+path.name
                assert decoded.info.get('icc_profile',b'')==profile, 'ICC mismatch: '+path.name
                assert decoded.info.get('exif',b'')==exif, 'EXIF mismatch: '+path.name
            return encoded,{'width':rgba.width,'height':rgba.height,'rgbaSha256':sha(raw),'iccProfileBytes':len(profile),'iccProfileSha256':sha(profile) if profile else None,'exifBytes':len(exif),'pixelsVerified':True}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--target-savings-mib',type=float,default=48.4);parser.add_argument('--max-new-mib',type=float,default=54);args=parser.parse_args()
    if (COURSE/'media-delivery.json').exists():
        raise SystemExit('This legacy lossless pass is superseded. Run python scripts/prepare-media-delivery.py instead.')
    assert features.check('webp'),'Pillow WebP support is required'
    target=int(args.target_savings_mib*MIB);cap=int(args.max_new_mib*MIB)
    before=media_bytes();chapters={p.name:json.loads(p.read_text()) for p in sorted((COURSE/'chapters').glob('*.json'))}
    content_before=content_digest(chapters)
    untouched={str(p.relative_to(ROOT)):file_sha(p) for p in [COURSE/'pyodide-validation.json',ROOT/'lib/generated/course-context.json'] if p.exists()}
    video_hashes={p.name:file_sha(p) for p in MEDIA.glob('*.mp4')}
    prior=json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    records=prior.get('conversions',[])
    # If the canonical import restored source PNGs, reuse already-verified output.
    for record in records:
        source=MEDIA/Path(record['original']).name;dest=MEDIA/Path(record['replacement']).name
        assert dest.exists() and file_sha(dest)==record['webpSha256'],'Missing or altered optimized asset; restore it or remove manifest before regenerating.'
        if source.exists():assert file_sha(source)==record['pngSha256'],'Canonical PNG changed; explicit re-optimization is required.'
    savings=sum(r['savedBytes'] for r in records);new_bytes=sum(r['webpBytes'] for r in records)
    initial_savings=savings;initial_new_bytes=new_bytes;initial_count=len(records)
    selected={Path(r['original']).name for r in records}
    referenced={Path(b['src']).name for c in chapters.values() for b in c['blocks'] if b['type']=='image' and b.get('src')}
    candidates=sorted((p for p in MEDIA.glob('*.png') if p.name in referenced and p.name not in selected),key=lambda p:(-p.stat().st_size,p.name))
    for source in candidates:
        if savings>=target:break
        encoded,verification=convert(source);size=source.stat().st_size
        if len(encoded)>=size:continue
        if new_bytes-initial_new_bytes+len(encoded)>=cap:break
        dest=source.with_suffix('.webp');assert not dest.exists(),'Unexpected pre-existing WebP: '+dest.name
        dest.write_bytes(encoded)
        record={'original':'/media/'+source.name,'replacement':'/media/'+dest.name,'pngBytes':size,'webpBytes':len(encoded),'savedBytes':size-len(encoded),'pngSha256':file_sha(source),'webpSha256':sha(encoded),**verification}
        records.append(record);savings+=record['savedBytes'];new_bytes+=len(encoded)
        print(json.dumps({'converted':source.name,'savedMiB':round(savings/MIB,2),'newWebpMiB':round((new_bytes-initial_new_bytes)/MIB,2),'roundSavedMiB':round((savings-initial_savings)/MIB,2),'rgbaVerified':True,'iccBytes':record['iccProfileBytes']}),flush=True)
    mapping={r['original']:r['replacement'] for r in records};references=0
    for name,chapter in chapters.items():
        changed=False
        for block in chapter['blocks']:
            if block['type']=='image' and block.get('src') in mapping:
                block['src']=mapping[block['src']];references+=1;changed=True
        if changed:dump(COURSE/'chapters'/name,chapter)
    assert content_digest(chapters)==content_before,'Non-media chapter content changed'
    for r in records:
        source=MEDIA/Path(r['original']).name
        if source.exists():source.unlink()
    after=media_bytes();index=json.loads((COURSE/'index.json').read_text());index['assets']['mediaBytes']=after
    index['assets']['losslessWebpImages']=len(records);index['assets']['mediaSavedBytes']=savings;dump(COURSE/'index.json',index)
    for c in chapters.values():
        for b in c['blocks']:
            if b['type'] in ('image','video') and b.get('available'):assert (ROOT/'public'/b['src'].lstrip('/')).is_file(),b['src']
    assert {p.name:file_sha(p) for p in MEDIA.glob('*.mp4')}==video_hashes,'Video bytes changed'
    assert all(file_sha(ROOT/p)==digest for p,digest in untouched.items()),'Context or Pyodide evidence changed'
    assert new_bytes-initial_new_bytes<cap
    report={'updatedAt':'2026-11-18','method':'Pillow WebP lossless=True, quality=75, method=4, exact=True; original ICC/EXIF preserved','targetSavingsBytes':target,'targetReached':savings>=target,'pngsConverted':len(records),'savedBytes':savings,'newWebpBytes':new_bytes,'roundConverted':len(records)-initial_count,'roundSavedBytes':savings-initial_savings,'roundNewWebpBytes':new_bytes-initial_new_bytes,'roundNewBytesLimit':cap,'totalMediaBytes':after,'allDecodedRgbaIdentical':True,'allIccProfilesPreserved':True,'courseContentUnchanged':True,'videosUnchanged':True,'conversions':records}
    dump(MANIFEST,report)
    assets=[{'src':'/media/'+p.name,'bytes':p.stat().st_size,'sha256':file_sha(p)} for p in sorted(MEDIA.iterdir()) if p.is_file()]
    dump(COURSE/'media-manifest.json',{'updatedAt':'2026-11-18','assetCount':len(assets),'totalBytes':after,'assets':assets})
    audit=ROOT/'docs/content-audit.md';text=audit.read_text()
    text=re.sub(r'已公开可用媒体 [\d,]+ 字节（[\d.]+ MiB）',f'已公开可用媒体 {after:,} 字节（{after/MIB:.2f} MiB）',text)
    text=text.replace('图片保持源文件字节。','未转换图片保持源文件字节；部分大 PNG 经像素一致验证后采用无损 WebP。')
    section=f'''## 发布体积优化\n\n- 原发布包超过平台 256 MiB 限制；按 PNG 体积降序，仅转换 {len(records)} 张图片为无损 WebP，达到至少 {args.target_savings_mib:g} MiB 节省目标后停止。\n- 共节省 {savings:,} 字节（{savings/MIB:.2f} MiB）；累计 WebP 共 {new_bytes:,} 字节（{new_bytes/MIB:.2f} MiB）。本轮新增 {len(records)-initial_count} 张，共 {new_bytes-initial_new_bytes:,} 字节（{(new_bytes-initial_new_bytes)/MIB:.2f} MiB），低于本轮 {args.max_new_mib:g} MiB 新文件预算；本轮额外节省 {(savings-initial_savings)/MIB:.2f} MiB。媒体现为 {after:,} 字节（{after/MIB:.2f} MiB）。\n- 每张转换图均逐字节验证解码后 RGBA 像素一致，并保留原始 ICC profile 与 EXIF（若存在）；只接受文件更小的输出。没有缩放、降色、裁剪或有损压缩。\n- 被替换 PNG 从发布目录移除，原始源图仍在课程 review_source 中；全部视频、正文、代码、章节 files、块 ID 和 Pyodide 验证报告不变。\n- 映射、像素哈希、原始/输出文件哈希与体积见 `public/course/media-optimization.json`；完整发布媒体清单见 `public/course/media-manifest.json`。\n- 可复现流程：运行课程导入器后，分两轮运行 `python scripts/optimize-course-media.py --target-savings-mib 24 --max-new-mib 48` 与 `python scripts/optimize-course-media.py --target-savings-mib 48.4 --max-new-mib 54`。预算按每轮新增计算；重复执行同一累计目标不会继续无必要转换；重新导入恢复 PNG 后会复用已核验转换记录。\n\n'''
    if '## 发布体积优化' in text:text=re.sub(r'## 发布体积优化\n.*?(?=\n## |\Z)',section.rstrip(),text,flags=re.S)
    else:text=text.replace('## 逐章清单',section+'## 逐章清单')
    audit.write_text(text)
    print(json.dumps({k:v for k,v in report.items() if k!='conversions'},ensure_ascii=False),flush=True)
    if savings<target:raise SystemExit('Stopped before target to respect the new-file byte cap; report is complete and consistent.')

if __name__=='__main__':main()
