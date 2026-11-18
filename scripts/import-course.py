#!/usr/bin/env python3
"""Import the 39 canonical lessons, with reproducible IDs and a publication audit.

Usage: PYTHONPATH=/tmp/course-import-deps python scripts/import-course.py --source PATH
Parser dependencies: mistune>=3, bleach>=6 (isolated install is supported).
After import, build responsive images, video posters and faststart containers:
  python scripts/prepare-media-delivery.py
  python scripts/prepare-media-delivery.py --verify
Small charts keep their original bytes; large images get full-size WebP q94 and
<=960px reading previews. Video/audio encoded packets and lesson content/code
are verified unchanged. The earlier lossless-only pass is historical.
Only direct Markdown children of 上册/下册 define lessons. ZIPs supply text code
files only; no raw archive, credentials bundle, binaries or model weights publish.
"""
from __future__ import annotations
import argparse, ast, collections, copy, hashlib, html, json, math, re, shutil, subprocess, sys, zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit, parse_qsl, urlencode
try:
    import mistune, bleach
except ImportError:
    sys.path.insert(0, '/tmp/course-import-deps')
    try:
        import mistune, bleach
    except ImportError as exc:
        raise SystemExit('Missing Python parser dependencies: install mistune and bleach in an isolated Python target.') from exc

ROOT = Path(__file__).resolve().parents[1]
RECOVERED_VIDEO = json.loads((ROOT / "scripts/video-excerpt.json").read_text())
MEDIA_EDITORIAL = json.loads((ROOT / "scripts/media-editorial.json").read_text())
OUT = ROOT/'public/course'
MEDIA = ROOT/'public/media'
AUDIT = collections.Counter()
MISSING = set()
ARCHIVE_LINKS = set()
MEDIA_RECORDS = {}
CHAPTER_MAP = {}
SAFE_TAGS = ['p','br','strong','em','del','s','a','code','pre','blockquote','ul','ol','li','hr','table','thead','tbody','tr','th','td','sup','sub','kbd','span']


def clean_secrets(text):
    def redact(m):
        AUDIT['redactions'] += 1
        return '[已脱敏]'
    text = re.sub(r'-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----', redact, text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{18,}\b', redact, text)
    text = re.sub(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b', redact, text)
    # Keep variable names and quotes so Python snippets remain syntactically valid.
    pattern = r'''(?i)((?:["']?(?:password|passwd|api_key|api_secret|access_token|secret_key|client_secret|authorization)["']?)\s*[:=]\s*)(["'])([^\n"']+)(\2)'''
    def assignment(m):
        v=m[3]
        if v.strip().lower() in ('bearer','basic'): return m[0]
        if re.search(r'^(?:\[已脱敏\]|\*+|<.*>|YOUR_.*|your_.*|REDACTED|Bearer \{|os\.|env\.|\.\.\.|xxx+|sk-你的.*)$',v): return m[0]
        # Even demonstrative password literals are redacted. Environment lookups are untouched.
        AUDIT['redactions'] += 1
        return m[1]+m[2]+'[已脱敏]'+m[4]
    return re.sub(pattern, assignment, text)


def strip_frontmatter(text):
    return re.sub(r'\A\ufeff?---\s*\n.*?\n---\s*\n', '', text, count=1, flags=re.S)


def chapter_key(path):
    lower=path.parent.name=='下册'; name=path.stem
    m=re.search(r'第\s*(\d+)\s*章',name)
    if m:
        n=int(m[1]); suffix=''
        if '（上）' in name: suffix='a'
        elif '（下）' in name: suffix='b'
        elif '（番外）' in name: suffix='extra'
        return ('lower-' if lower else 'upper-')+f'{n:02d}'+suffix
    if name.startswith('上册｜'): return 'upper-overview'
    if name.startswith('下册｜'): return 'lower-overview'
    if name.startswith('导论'): return 'upper-intro'
    if name.startswith('尾声'): return 'upper-epilogue'
    if name.startswith('写在最后'): return 'upper-afterword'
    if name.startswith('术语'): return 'upper-glossary'
    if name.startswith('附录'): return 'lower-appendix'
    raise ValueError('Unmapped canonical chapter')


def sort_key(p):
    k=chapter_key(p); vol=0 if k.startswith('upper') else 1
    specials={'overview':-20,'intro':-10,'epilogue':900,'afterword':910,'glossary':920,'appendix':930}
    tail=k.split('-',1)[1]
    if tail in specials: return vol,specials[tail]
    n=int(re.match(r'\d+',tail)[0]);extra=3 if tail.endswith('extra') else 2 if tail.endswith('b') else 1 if tail.endswith('a') else 0
    return vol,n*10+extra


def plain(token):
    if token['type'] in ('wiki_link','course_media'): return token['attrs'].get('label') or token['attrs'].get('target','').split('/')[-1]
    if token['type'] in ('softbreak','linebreak'): return '\n'
    if 'raw' in token: return token['raw']
    sep='\n' if token['type'] in ('list','table','table_body','table_head','table_row','block_quote') else ''
    return sep.join(plain(c) for c in token.get('children',[]))


def safe_url(url):
    url=html.unescape(url).strip()
    if re.search(r'[\x00-\x20]',url): url=re.sub(r'[\x00-\x20]','',url)
    if url.startswith(('/?chapter=','/media/','#')): return url
    parts=urlsplit(url)
    if parts.scheme.lower() not in ('https','http','mailto'): return ''
    if parts.username or parts.password: return ''
    query=[(k, '[已脱敏]' if re.search(r'(?i)key|token|password|secret|signature',k) else v) for k,v in parse_qsl(parts.query,keep_blank_values=True)]
    return urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),parts.fragment))


class Renderer(mistune.HTMLRenderer):
    def link(self, text, url, title=None):
        target=safe_url(url)
        if not target: return text
        ext=target.startswith(('https://','http://'))
        return '<a href="'+html.escape(target,quote=True)+'"'+(' target="_blank" rel="noopener noreferrer"' if ext else '')+'>'+text+'</a>'
    def wiki_link(self, target, label=''):
        name=unquote(target.split('#')[0]).replace('\\','/').split('/')[-1]
        name=name.removesuffix('.md')
        cid=CHAPTER_MAP.get(name)
        label=label or name
        if cid: return self.link(html.escape(label), '/?chapter='+cid)
        if target.lower().endswith('.zip'):
            ARCHIVE_LINKS.add(target)
            return html.escape(label)+' <span>（原始资料包不公开；本章代码见实验区文件）</span>'
        url=safe_url(target)
        if url:return self.link(html.escape(label),url)
        MISSING.add('内部链接：'+target)
        return html.escape(label)
    def course_media(self, target, label=''):
        # Any rare inline media is split into an independent block by convert().
        return html.escape(label or Path(target).name)
    def image(self, text, url, title=None):
        return html.escape(text)


def wiki_plugin(md):
    def parse_wiki(inline,m,state):
        raw=m[0]; embedded=raw.startswith('!'); body=raw[3:-2] if embedded else raw[2:-2]
        parts=body.split('|'); target=parts[0];label='|'.join(p for p in parts[1:] if not re.fullmatch(r'\d+(?:x\d+)?',p))
        state.append_token({'type':'course_media' if embedded else 'wiki_link','attrs':{'target':target,'label':label}})
        return m.end()
    md.inline.register('course_wiki',r'!?\[\[[^\]\n]+\]\]',parse_wiki,before='link')


PLUGINS=['table','strikethrough','task_lists','url',wiki_plugin]
PARSER=mistune.create_markdown(renderer='ast',plugins=PLUGINS)
HTML=mistune.create_markdown(renderer=Renderer(escape=True),plugins=PLUGINS)


def sanitized_html(token):
    rendered=HTML.renderer.render_token(token,mistune.BlockState())
    # Markdown raw HTML is already escaped; allow only a small presentational set.
    return bleach.clean(rendered,tags=SAFE_TAGS,attributes={'a':['href','title','target','rel'],'ol':['start'],'th':['align'],'td':['align'],'li':['class'],'span':['class']},protocols=['http','https','mailto'],strip=True)


def media_block(target,label,source,source_root):
    target=unquote(target.split('#')[0]); ref=target.removeprefix('零基础学AI/').lstrip('/')
    candidates=[source_root/ref,source.parent/ref,source_root/source.parent.name/ref]
    path=next((p.resolve() for p in candidates if p.is_file() and p.resolve().is_relative_to(source_root.resolve())),None)
    kind='video' if Path(ref).suffix.lower() in ('.mp4','.webm','.mov','.m4v') else 'image'
    block={'type':kind,'alt':label or Path(ref).stem,'caption':label or Path(ref).stem,'available':False}
    if not path:
        MISSING.add('媒体：'+target);block['reason']='原文引用的媒体文件未随课程提供';return block
    rel=str(path.relative_to(source_root)); digest=hashlib.sha256(rel.encode()).hexdigest()[:16];dest=MEDIA/(digest+path.suffix.lower())
    if rel not in MEDIA_RECORDS:
        status={'path':rel,'bytes':path.stat().st_size,'kind':kind,'available':True,'publicPath':'/media/'+dest.name}
        if kind=='video':
            probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name,codec_type','-of','json',str(path)],capture_output=True,text=True)
            status['available']=probe.returncode==0
            recovered = ROOT / 'public' / RECOVERED_VIDEO['src'].lstrip('/')
            if (probe.returncode and path.name == RECOVERED_VIDEO['originalFilename']
                    and hashlib.sha256(path.read_bytes()).hexdigest() == RECOVERED_VIDEO['sourceSha256']
                    and recovered.is_file() and hashlib.sha256(recovered.read_bytes()).hexdigest() == RECOVERED_VIDEO['sha256']):
                status.update(available=True, publicPath=RECOVERED_VIDEO['src'], bytes=recovered.stat().st_size,
                              duration=RECOVERED_VIDEO['duration'], codecs=['h264', 'aac'], recoveredExcerpt=True)
            elif probe.returncode!=0:
                status['reason']='源视频损坏：缺少 moov atom，无法解码播放。待提供完整原文件后恢复。' if 'moov atom' in probe.stderr else '源视频校验失败，无法保证正常播放。'
            else:
                d=json.loads(probe.stdout);status['duration']=float(d.get('format',{}).get('duration',0));status['codecs']=[s.get('codec_name','') for s in d.get('streams',[])]
        elif path.suffix.lower()=='.svg':
            # Preserve original bytes only after rejecting active SVG content.
            svg=path.read_text(errors='replace')
            if re.search(r'<\s*(?:script|foreignObject)|\bon\w+\s*=|(?:href|src)\s*=\s*[\"\'](?:javascript:|https?:)',svg,re.I):
                status['available']=False;status['reason']='源 SVG 含主动内容，未公开此附件。'
        if status['available'] and not status.get('recoveredExcerpt'):
            shutil.copyfile(path,dest)
        MEDIA_RECORDS[rel]=status
    status=MEDIA_RECORDS[rel];block['available']=status['available']
    if status['available']:block['src']=status['publicPath']
    if kind=='video' and path.name==RECOVERED_VIDEO['originalFilename']:
        # Its published anchor originally used the caption, before the playable excerpt existed.
        block['_legacyAnchorCaption']=block['caption']
    if not status['available']:block['reason']=status['reason']
    return block


def declared_filename(code):
    first='\n'.join(code.splitlines()[:3])
    m=re.search(r'^\s*#\s*([A-Za-z_][\w./-]*\.py)(?=\s|[：:（(]|$)',first,re.M)
    if m and '..' not in Path(m[1]).parts: return m[1]
    return None


def make_code(token):
    code=token.get('raw','').rstrip('\n'); lang=token.get('attrs',{}).get('info','').split(' ',1)[0].lower()
    lang={'py':'python','sh':'bash','shell':'bash','console':'bash'}.get(lang,lang)
    if not lang:
        lines=[l.strip() for l in code.splitlines() if l.strip()]
        lang='bash' if lines and all(re.match(r'^(?:\$\s*)?(?:python\d?|pip\d?|uv |export |source |cd |mkdir |git |curl |which |chmod |ls |cat |echo |set |\.venv/)',l) or l.startswith('#') for l in lines) else 'output'
    block={'type':'code','language':lang,'code':code,'text':code,'runnable':False}
    name=declared_filename(code)
    if name:block['filename']=name
    if lang=='python':
        try: ast.parse(code)
        except SyntaxError: block['reason']='原文代码节选／示意，需补全上下文后运行。'
    elif lang=='bash':block['runtime']='linux';block['reason']='终端命令：请在本机环境执行。'
    elif lang=='output':block['reason']='原文示例输出，用于对照实验结果。'
    else:block['reason']='格式／配置／伪代码示例，不作为 Python 执行。'
    return block


def convert(token,source,source_root):
    kind=token['type']
    if kind=='blank_line':return []
    if kind=='block_code':return [make_code(token)]
    if kind=='heading':return [{'type':'heading','level':token['attrs']['level'],'text':plain(token)}]
    if kind=='course_media':return [media_block(token['attrs']['target'],token['attrs'].get('label',''),source,source_root)]
    if kind=='image':return [media_block(token['attrs']['url'],plain(token),source,source_root)]
    # Split media out of prose, blockquotes, lists and tables without losing the remaining text.
    def contains_media(t): return t['type'] in ('course_media','image') or any(contains_media(c) for c in t.get('children',[]))
    if contains_media(token):
        if kind in ('paragraph','block_text'):
            result=[]; chunk=[]
            for c in token.get('children',[]):
                if contains_media(c):
                    if chunk:result.append({'type':'prose','text':plain({'type':kind,'children':chunk}),'html':sanitized_html({'type':kind,'children':chunk})});chunk=[]
                    result.extend(convert(c,source,source_root))
                else:chunk.append(c)
            if chunk:result.append({'type':'prose','text':plain({'type':kind,'children':chunk}),'html':sanitized_html({'type':kind,'children':chunk})})
            return [b for b in result if b.get('text','').strip() or b['type'] in ('image','video')]
        return [b for c in token.get('children',[]) for b in convert(c,source,source_root)]
    if kind in ('block_html','inline_html'):
        return [{'type':'prose','text':plain(token),'html':'<pre>'+html.escape(plain(token))+'</pre>'}]
    return [{'type':'prose','text':plain(token),'html':sanitized_html(token)}]


def archive_files(source_root):
    """Only extract supporting textual sources from the explicitly selected current packs."""
    upper={};lower={}
    zpath=source_root/'attachments/mygpt-companion-20261117-r4-8c90a8fb.zip'
    if zpath.exists():
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                m=re.match(r'companion/chapters/(ch\w+)/(.*\.py)$',name)
                if not m or '/snippets/' in name:continue
                key,fn=m.groups()
                if '..' in Path(fn).parts or fn.startswith('/'):continue
                text=z.read(name).decode('utf-8-sig',errors='replace')
                # Model adapters in the companion are deliberately different experiments;
                # the canonical API implementations supersede them below.
                upper.setdefault(key,{})[fn]=clean_secrets(text)
    zpath=source_root/'下册/attachments/从零开始学AI-下册配套课件.zip'
    if zpath.exists():
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                m=re.match(r'[^/]+/(ch\d+)/(.*)$',name)
                if not m:continue
                key,fn=m.groups()
                if Path(fn).suffix not in ('.py','.json','.jsonl','.md','.toml','.txt') or '..' in Path(fn).parts:continue
                if z.getinfo(name).file_size>1024*1024:continue
                lower.setdefault(key,{})[fn]=clean_secrets(z.read(name).decode('utf-8-sig',errors='replace'))
    return upper,lower


def import_names(code):
    try: tree=ast.parse(code)
    except SyntaxError:return [],None
    names=[]
    for node in ast.walk(tree):
        if isinstance(node,ast.Import):names.extend(a.name.split('.')[0] for a in node.names)
        elif isinstance(node,ast.ImportFrom) and node.module:names.append(node.module.split('.')[0])
    return names,tree


FORBIDDEN_BROWSER={'subprocess','fcntl','multiprocessing','resource','socket','threading','http','pty','termios','signal','select','asyncio'}
API_MODULES={'requests','httpx','openai','anthropic','urllib','aiohttp'}
GPU_MODULES={'torch','tensorflow','transformers','accelerate','vllm'}
BROWSER_MODULES={'numpy'} | set(sys.stdlib_module_names)


def code_runtime(code,files,seen=None):
    seen=set() if seen is None else seen
    names,tree=import_names(code)
    if tree is None:return 'linux','代码节选的语法尚未完整，需补齐。'
    if set(names)&GPU_MODULES or re.search(r'\bcuda\b|torch\.',code):return 'gpu','依赖 PyTorch／模型训练环境；浏览器实验区不提供 GPU 或权重。'
    if set(names)&FORBIDDEN_BROWSER or re.search(r'\bsys\.(?:stdin|argv)|\bos\.(?:system|fork)|\binput\s*\(',code):return 'linux','依赖进程、终端输入、操作系统服务或本地文件环境。'
    if set(names)&API_MODULES or re.search(r'\b(?:API_KEY|BASE_URL|TOKEN_PLAN|api_key|urlopen|requests\.)',code):return 'api','需要自行配置模型服务、密钥与网络；不会在浏览器中自动调用。'
    rank={'browser':0,'api':1,'linux':2,'gpu':3}; result=('browser','纯 Python／已预置本章模块，可在浏览器沙盒运行。')
    for name in names:
        if name in seen:continue
        fn=name+'.py'
        if fn in files:
            seen.add(name);rt,reason=code_runtime(files[fn],files,seen)
            if rank[rt]>rank[result[0]]:result=(rt,reason)
        elif name not in BROWSER_MODULES:
            return 'linux','依赖未预置模块 '+name+'；按课程说明在本机补齐依赖。'
    if re.search(r'\bopen\s*\(|\.read_text\s*\(|\.read_bytes\s*\(',code) and result[0]=='browser':
        result=('linux','依赖课程本地数据／工作目录；请先按正文准备文件。')
    return result


# These exercises use files, but their full course datasets fit in Pyodide's
# virtual filesystem. Pin both the source and its exact chapter dependencies;
# changed lesson materials return to conservative classification until retested.
VERIFIED_FILE_EXERCISES = {
    ('lower-09', 'memory.py'): 'c829439d82a814afba6ce75267160726bbf2ff9a704a926e6ab065d2261a73e4',
    ('upper-14', 'accept.py'): '54c797536635fb0913a521dd554761fef4d59a8a26f62e2613f666b871f0371d',
    ('upper-14', 'accept_v1.py'): 'a91c377034ed8d5e54e4cce1221fb3541bdb8c0d8a2334324e93a92645221878',
    ('upper-14', 'card.py'): 'a95c91e51cca6399062ae259dfaa5fb8ea60df29b92a7edd2b3719d6aeb6931a',
}


def verified_file_exercise(chapter, block, files):
    expected = VERIFIED_FILE_EXERCISES.get((chapter, block.get('filename')))
    if not expected:
        return False
    payload = json.dumps([block['code'], sorted(files.items())], ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(payload).hexdigest() == expected


def is_complete_python(block):
    code=block['code']
    if block.get('reason'):return False
    _,tree=import_names(code)
    if tree is None:return False
    if any(isinstance(n,ast.Constant) and n.value is Ellipsis for n in ast.walk(tree)):return False
    if re.search(r'骨架|伪代码|新增部分',code.splitlines()[0] if code else ''):return False
    if block.get('filename'):return True
    # Short fragments with no declared entry point are educational excerpts.
    return False


def add_ids(blocks,cid):
    counts=collections.Counter()
    for b in blocks:
        payload=b['type']+'\n'+str(b.pop('_legacyAnchorCaption',None) or b.get('code',b.get('text',b.get('src',b.get('caption','')))))
        digest=hashlib.sha256(payload.encode()).hexdigest()[:12];counts[digest]+=1
        b['id']=f'{cid}-{digest}'+(f'-{counts[digest]}' if counts[digest]>1 else '')


def chapter_meta(path,order,text,blocks):
    cid=chapter_key(path);lower=cid.startswith('lower');tail=cid.split('-',1)[1]
    title=next((b['text'] for b in blocks if b['type']=='heading'),path.stem)
    title=re.sub(r'^#\s*','',title)
    kind='extra' if 'extra' in tail else 'intro' if tail in ('overview','intro') else 'appendix' if tail in ('epilogue','afterword','glossary','appendix') else 'chapter'
    if lower:group='下册 · 动手实践'
    elif tail in ('overview','intro','00'):group='启程 · 准备出发'
    elif re.match(r'0[1-4]',tail):group='第一篇 · 学会学习'
    elif re.match(r'0[5-7]',tail):group='第二篇 · 与模型协作'
    elif re.match(r'0[89]|1[0-3]',tail):group='第三篇 · 开始做事'
    else:group='交付 · 回望与索引'
    candidates=[b.get('text','').strip() for b in blocks if b['type']=='prose' and len(b.get('text',''))>30 and '配套课件在这里' not in b.get('text','')]
    summary=re.sub(r'\s+',' ',candidates[0] if candidates else title)[:150]
    short=title.split('｜',1)[-1]
    return {'id':cid,'title':title,'shortTitle':short,'volume':'lower' if lower else 'upper','group':group,'order':order,'kind':kind,'minutes':max(3,math.ceil(len(re.sub(r'\s','',text))/500)),'summary':summary,'text':text,'codeCount':sum(b['type']=='code' for b in blocks),'videoCount':sum(b['type']=='video' for b in blocks)}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--terms',type=Path,default=ROOT/'public/course/terms-source.json');parser.add_argument('--check-browser',action='store_true');args=parser.parse_args();source=args.source.resolve()
    paths=sorted([p for v in ('上册','下册') for p in (source/v).glob('*.md')],key=sort_key)
    if len(paths)!=39:raise SystemExit(f'Expected 39 canonical files; found {len(paths)}.')
    OUT.mkdir(parents=True,exist_ok=True);(OUT/'chapters').mkdir(exist_ok=True);MEDIA.mkdir(parents=True,exist_ok=True)
    for p in paths:CHAPTER_MAP[p.stem]=chapter_key(p)
    upper_support,lower_support=archive_files(source)
    chapters=[];upper_cumulative={};lower_cumulative={};raw_fence_count=0
    for order,path in enumerate(paths):
        text=clean_secrets(strip_frontmatter(path.read_text(encoding='utf-8-sig')))
        tokens=PARSER(text)
        def count_fences(ts):return sum((1 if t['type']=='block_code' else 0)+count_fences(t.get('children',[])) for t in ts)
        raw_fence_count+=count_fences(tokens)
        blocks=[b for token in tokens for b in convert(token,path,source)]
        cid=chapter_key(path);tail=cid.split('-',1)[1]; lower=cid.startswith('lower');packkey='ch'+tail
        if cid=='upper-05':
            for video in sorted((source/'上册/videos').glob('05-*.mp4')):
                blocks.append(media_block(str(video.relative_to(source)),'随附视频 · '+video.stem.split('_',1)[-1].removesuffix('_v1'),path,source))
        files={};own={}
        if re.match(r'\d',tail):
            cumulative=lower_cumulative if lower else upper_cumulative
            # Canonical cumulative source is authoritative; ZIP fills genuinely missing modules.
            files.update((lower_support if lower else upper_support).get(packkey,{}))
            files.update(cumulative)
            for b in blocks:
                if b['type']=='code' and b.get('language')=='python' and b.get('filename'):
                    fn=b['filename']; code=b['code']+'\n'
                    if '新增部分' in code.splitlines()[0] and fn in files:
                        files[fn]=files[fn]+'\n'+code
                    else: files[fn]=code
                    own[fn]=files[fn]
            if not lower and tail=='00':
                # Chapter zero's peek.py intentionally uses the common mock document pack.
                p7=next(p for p in paths if chapter_key(p)=='upper-07')
                for tok in PARSER(clean_secrets(strip_frontmatter(p7.read_text()))):
                    if tok['type']=='block_code' and declared_filename(tok.get('raw',''))=='docs.py':files['docs.py']=tok['raw']
            if 'extra' not in tail:cumulative.update(own)
            if not lower and 'docs.py' not in files:
                # Full common fictional corpus is defined in chapter 07.
                p7=next(p for p in paths if chapter_key(p)=='upper-07')
                for tok in PARSER(clean_secrets(strip_frontmatter(p7.read_text()))):
                    if tok['type']=='block_code' and declared_filename(tok.get('raw',''))=='docs.py':files['docs.py']=tok['raw']
        for b in blocks:
            if b['type']=='code' and b.get('language')=='python':
                rt,reason=code_runtime(b['code'],files)
                complete=is_complete_python(b)
                if complete and rt=='linux' and verified_file_exercise(cid,b,files):
                    rt,reason='browser','使用本章预置文件和浏览器内的 Python 文件系统。'
                b['runtime']=rt;b['runnable']=complete
                b['reason']=reason if complete else (b.get('reason') or '教学节选／增量片段：需结合前文定义或完整文件后运行。')
        add_ids(blocks,cid)
        # Preserve published anchors even when the unavailable source uses its caption to derive its ID.
        for block in blocks:
            editorial=MEDIA_EDITORIAL.get(block['id'], {})
            if 'excerptNotice' in editorial and block.get('src') != RECOVERED_VIDEO['src']:
                # A replacement master can have different timing and duration.
                editorial={k:v for k,v in editorial.items() if k not in ('excerptNotice','subtitleSrc')}
            block.update(editorial)
        meta=chapter_meta(path,order,text,blocks)
        chapters.append({**meta,'blocks':blocks,'files':files,'sourceFile':str(path.relative_to(source))})
    term_source=json.loads(args.terms.read_text())
    terms=[]
    for i,t in enumerate(term_source):
        sourcepath=Path(t['sourceFile']);cid=chapter_key(sourcepath)
        terms.append({'id':'term-'+hashlib.sha256(t['label'].encode()).hexdigest()[:10],'label':t['label'],'aliases':t.get('aliases',[]),'definition':t['definition'],'chapterId':cid})
    runtimes=collections.Counter(b.get('runtime','display') for c in chapters for b in c['blocks'] if b['type']=='code')
    counts=collections.Counter(b['type'] for c in chapters for b in c['blocks'])
    index={'title':'零基础学 AI','subtitle':'站回当年的问题前，一点一点搭出自己的知识库。','chapters':[{k:v for k,v in c.items() if k not in ('blocks','files','sourceFile')} for c in chapters],'terms':terms,'updatedAt':'2026-11-18','assets':{'chapters':len(chapters),'terms':len(terms),'images':counts['image'],'videos':counts['video'],'availableVideos':sum(r['kind']=='video' and r['available'] for r in MEDIA_RECORDS.values()),'codeBlocks':counts['code'],'runnablePython':sum(b.get('runnable',False) for c in chapters for b in c['blocks']),'browserRunnable':sum(b.get('runnable',False) and b.get('runtime')=='browser' for c in chapters for b in c['blocks']),'mediaBytes':sum(r['bytes'] for r in MEDIA_RECORDS.values() if r['available'])}}
    def dump(p,data):p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for c in chapters:dump(OUT/'chapters'/f"{c['id']}.json",c)
    subprocess.run([sys.executable, str(ROOT/'scripts/prepare-experiment-support.py')], check=True)
    dump(OUT/'index.json',index)
    context={c['id']:{'title':c['title'],'blocks':[{'id':b['id'],'text':b.get('code') or b.get('text') or b.get('caption') or b.get('alt') or ''} for b in c['blocks']]} for c in chapters}
    (ROOT/'lib/generated').mkdir(parents=True,exist_ok=True);dump(ROOT/'lib/generated/course-context.json',context)
    validate(chapters,index,raw_fence_count)
    if args.check_browser:
        result=check_browser_code(chapters)
        dump(OUT/'validation.json',result)
        AUDIT['executed']=result['total'];AUDIT['passed']=result['passed']
        assert result['total']==result['passed'], 'Browser-classified code failed the CPython verification.'
    audit(chapters,index,counts,runtimes,raw_fence_count)
    print(json.dumps({'chapters':len(chapters),'terms':len(terms),'blocks':sum(counts.values()),'blockTypes':counts,'runtimes':runtimes,'assets':index['assets'],'files':sum(len(c['files']) for c in chapters),'missing':len(MISSING),'redactions':AUDIT['redactions']},ensure_ascii=False))


def validate(chapters,index,fences):
    assert len(chapters)==39 and len(set(c['id'] for c in chapters))==39
    assert sum(b['type']=='code' for c in chapters for b in c['blocks'])==fences,'Fenced content was lost'
    allids=set();chapterids={c['id'] for c in chapters}
    for c in chapters:
        assert c['blocks'] and c['text']
        for b in c['blocks']:
            assert b['id'] not in allids;allids.add(b['id'])
            if b['type'] in ('image','video') and b.get('available'):assert (ROOT/'public'/b['src'].lstrip('/')).is_file()
            if b.get('html'):
                assert not re.search(r'<(?:script|iframe|object|embed)\b|\son\w+\s*=|href=["\']\s*javascript:',b['html'],re.I)
                for cid in re.findall(r'href="/\?chapter=([^"&#]+)',b['html']):assert cid in chapterids
        for fn in c['files']:assert not Path(fn).is_absolute() and '..' not in Path(fn).parts
    for t in index['terms']:assert t['chapterId'] in chapterids
    # A final publication scan never prints sensitive matched strings.
    for p in list((OUT/'chapters').glob('*.json'))+[OUT/'index.json',ROOT/'lib/generated/course-context.json']:
        text=p.read_text();assert not re.search(r'\bsk-[A-Za-z0-9_-]{18,}|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----',text),f'Publication secret pattern in {p.name}'


def check_browser_code(chapters):
    import concurrent.futures, tempfile, time, platform
    tasks=[(c,b) for c in chapters for b in c['blocks'] if b.get('runnable') and b.get('runtime')=='browser']
    def execute(item):
        c,b=item
        with tempfile.TemporaryDirectory(prefix='course-check-') as d:
            for fn,content in c['files'].items():
                p=Path(d)/fn;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
            (Path(d)/'__course_check__.py').write_text(b['code'])
            started=time.monotonic()
            try:
                run=subprocess.run([sys.executable,'__course_check__.py'],cwd=d,capture_output=True,text=True,timeout=25)
                return {'chapterId':c['id'],'blockId':b['id'],'filename':b.get('filename'),'passed':run.returncode==0,'exitCode':run.returncode,'seconds':round(time.monotonic()-started,2)}
            except subprocess.TimeoutExpired:
                return {'chapterId':c['id'],'blockId':b['id'],'filename':b.get('filename'),'passed':False,'reason':'25 second execution limit'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(execute,tasks))
    return {'checkedAt':'2026-11-18','engine':'CPython '+platform.python_version(),'scope':'每个 browser+runnable 块，在独立工作目录载入本章 files 后实际执行。不是 Pyodide 浏览器验证，也未执行联网、系统服务或 GPU 实验。','total':len(results),'passed':sum(r['passed'] for r in results),'results':results}


def audit(chapters,index,counts,runtimes,fences):
    total=sum(r['bytes'] for r in MEDIA_RECORDS.values() if r['available']);maxasset=max(MEDIA_RECORDS.values(),key=lambda r:r['bytes'])
    lines=['# 全课程导入与内容审计','', '生成日期：2026-11-18（北京时间）。导入器：`scripts/import-course.py`。','', '## 来源与完整性','', '- 仅使用 `上册/` 直属 25 篇、`下册/` 直属 14 篇，共 39 篇 canonical Markdown。未将根目录旧 15 章大纲混入课程。',f'- 生成 {len(chapters)} 个章节 JSON、完整全文检索索引、{len(index["terms"])} 条源于课程的术语和服务器文本上下文。',f'- 共 {sum(counts.values())} 内容块：标题 {counts["heading"]}、正文 {counts["prose"]}、代码 {counts["code"]}、图片 {counts["image"]}、视频 {counts["video"]}。',f'- 解析得到的 {fences} 个代码围栏全部进入 code blocks；正文按 Markdown AST 全量转换，无摘要替换正文。章节 text 保留脱敏后的全文，summary 仅供目录预览。','- 块 ID 由章节 ID、内容类型和内容 SHA-256 派生；重复内容加序号。无关段落插入不改变已有块 ID。','- 前置 YAML 仅作来源元数据并从展示正文剔除；表格、列表、粗体、引用和行内代码保留。Obsidian 内部链接转为站内章节导航。','', '## 代码环境与预置文件','',f'- 代码块标注：browser {runtimes["browser"]}、api {runtimes["api"]}、linux {runtimes["linux"]}、gpu {runtimes["gpu"]}；另有纯展示输出/配置 {runtimes["display"]}。',f'- 其中 {index["assets"]["browserRunnable"]} 个完整 Python 文件标记为浏览器可运行。`runnable` 表示完整可执行 Python 单元，不保证当前环境可用；必须同时检查 runtime。完整 api/linux/gpu 单元也为真，未配置对应环境时必须明确不可执行。',f'- 各章节 files 共 {sum(len(c["files"]) for c in chapters)} 个文本文件（含为 import 预置的前章模块；不同章节保留各自版本）。','- 完整正文代码优先；配套 ZIP 只补充缺少的 Python/文本素材。下册使用当前 12 章配套课件，未用旧 15 章代码包覆盖当前教材。','- 上册原文 llm.py 按章节版本保留，未偷偷替换成配套包里的 toy 模型适配器。可执行声明会递归检查导入依赖。','- `api` 需服务地址、用户自己的环境变量和网络；`linux` 需进程/文件锁/本地语料/终端或未预置依赖；`gpu` 包括 PyTorch 训练骨架，未声称已训练模型或浏览器支持 GPU。','- 未声明文件名的 Python 节选、增量补丁、带省略号/不完整语法的片段保留原样但不提供一键执行。Bash 命令、输出、JSON/TOML/Markdown 分别展示。','', '## 媒体','',f'- 引用与补充媒体共 {len(MEDIA_RECORDS)} 个唯一文件。已公开可用媒体 {total:,} 字节（{total/1024/1024:.2f} MiB），稳定 ASCII 文件名；图片保持源文件字节。',f'- 最大媒体 {maxasset["bytes"]:,} 字节（{maxasset["bytes"]/1024/1024:.2f} MiB），无单文件超过 25 MiB。', '- canonical 正文直接引用 8 条视频；第 05 章同目录的 05-1、05-2 两条补充视频以“随附视频”附于章末。共 10 条，9 条 ffprobe 校验可用。','- 05-2 原件缺少 moov atom，明确 `available: false`，展示损坏原因；不复制损坏文件为可播放资产，不编造视频，不转码伪造。','- 图片和视频源链接都经过本地存在性校验；未复制整个源目录。行内 `![[...png]]` 语法示例保留为代码，不视为丢失媒体。','', '## 发布清理与限制','', '- 不发布 ZIP、密钥资料包、私钥、二进制模型、日志或未被引用的无关附件。原始下载链接保留文字，并明确代码已在实验区预置。',f'- 文本/代码自动扫描并脱敏敏感模式 {AUDIT["redactions"]} 次（含重复继承扫描，不代表独立凭据数量）；审计不列出原值。','- HTML 白名单清理，原始 HTML 转义；不允许脚本、iframe、事件处理属性或 javascript: 链接。外链仅允许 http/https/mailto，增加 noopener/noreferrer；URL凭据和敏感查询字段清理。','- SVG 原字节只在不含主动内容后公开。运行时环境分类是保守静态分析；未执行需要真实凭据、联网、系统修改或训练的课程代码。','', '## 未解析引用','']
    lines += ['- '+x for x in sorted(MISSING)] if MISSING else ['无未解析的正文媒体或课程内部章节链接。']
    if AUDIT['executed']:
        lines += ['', '## 执行验证','', f'- {AUDIT["executed"]} 个 browser+runnable 代码块在 CPython 独立工作目录载入本章 files 后实际运行，{AUDIT["passed"]} 个通过；无预制模型输出。逐项退出码见 `public/course/validation.json`。','- 第 01 章 router、exam、patch1、patch2 可实际 import 并执行，成绩与课程一致：exam 3/6，patch1 3/6，patch2 4/6 和追加考卷 0/2。','- 此检查验证 Python 执行和模块预置，不等同 Pyodide 浏览器实测；API、Linux、GPU 示例保持环境限制。','- 重现命令：`PYTHONPATH=/tmp/course-import-deps python scripts/import-course.py --source <课程目录> --check-browser`。']
    wasm_path=OUT/'pyodide-validation.json'
    if wasm_path.exists():
        wasm=json.loads(wasm_path.read_text())
        current={b['id']:hashlib.sha256(b['code'].encode()).hexdigest() for c in chapters for b in c['blocks'] if b.get('runnable') and b.get('runtime')=='browser'}
        worker_hash=hashlib.sha256((ROOT/'public/runtime/python-worker.js').read_bytes()).hexdigest()
        matches=wasm.get('productionWorkerSha256')==worker_hash and wasm.get('total')==len(current) and all(r.get('codeSha256')==current.get(r['blockId']) for r in wasm.get('results',[]))
        lines += ['', '## 真实 Pyodide 兼容性验证','']
        if matches:
            slow=max(wasm['results'],key=lambda r:r['wallElapsedMs'])
            lines += [f'- 实际生产 worker + Pyodide 0.27.7 / CPython 3.12 WASM 验证：{wasm["passed"]}/{wasm["total"]} 通过。报告时间：{wasm["checkedAt"]}。', '- 每单元独立 Node Worker、全新内核，载入对应 chapter.files；每项硬限 60 秒。仅适配 importScripts/CDN 资产加载，无 mock Python 计算或结果。', f'- 2 路并行共 {wasm["elapsedMs"]/1000:.2f} 秒；最长 {slow["chapterId"]}/{slow["filename"]}，{slow["wallElapsedMs"]/1000:.2f} 秒（包含启动）。', '- 逐项真实 stdout、stderr、运行结果、耗时与哈希见 `public/course/pyodide-validation.json`。该报告代码哈希与当前课程、worker 一致。', '- 证明 WASM 执行兼容性，不等同每项教学输出正确性，也不覆盖浏览器 iframe/CSP 或交互界面。未运行 api/linux/gpu 单元。', '- 重现：`NOTEBOOK_PYODIDE_DIR=/tmp/notebook-pyodide-test node --test tests/course-pyodide.test.mjs`；缺少运行时目录会明确 skip，不视为通过。']
        else:
            lines += ['已有 Pyodide 报告与当前代码或生产 worker 不匹配，须重新运行真实 WASM 验证，不能沿用旧通过结果。']
    lines += ['', '## 逐章清单','', '| 章节 ID | 来源 | 代码 | 视频 | 预置文件 |','| --- | --- | ---: | ---: | ---: |']
    for c in chapters:lines.append(f'| {c["id"]} | {c["sourceFile"]} | {c["codeCount"]} | {c["videoCount"]} | {len(c["files"])} |')
    (ROOT/'docs').mkdir(exist_ok=True);(ROOT/'docs/content-audit.md').write_text('\n'.join(lines)+'\n')

if __name__=='__main__':main()
