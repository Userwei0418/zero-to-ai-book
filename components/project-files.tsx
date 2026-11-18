'use client';
import { useMemo, useRef, useState } from 'react';
import { Download, FileCode2, FileText, FolderOpen, Play, RotateCcw, Sparkles, Upload } from 'lucide-react';
import { ExperimentDownload } from './notebook';
import './project-files.css';

type Props = { initialFilename?: string; files: Record<string,string>; originalFiles: Record<string,string>; onChange:(filename:string,code:string)=>void; onRun:(filename:string,code:string)=>void; runUnavailable:(filename:string,code:string)=>string|undefined; onAsk:(filename:string,code:string)=>void };
const FILE_LIMIT = 128 * 1024;
const PROJECT_LIMIT = 700 * 1024;
const allowed = /\.(py|txt|csv|json|md|yaml|yml|toml|ini|cfg|sh)$/i;
const bytes = (text: string) => new TextEncoder().encode(text).length;
function safePath(name: string) { return Boolean(name && name.length <= 240 && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !/^[a-z]:/i.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && !['__proto__','constructor','prototype'].includes(part) && !part.startsWith('.')) && allowed.test(name) && !/(^|\/)(credentials?|secrets?|id_rsa|id_ed25519)(\.|$)/i.test(name)); }
function saveFile(name: string, content: string, type='text/plain;charset=utf-8') { const url=URL.createObjectURL(new Blob([content],{type})); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
export function ProjectFiles({initialFilename,files,originalFiles,onChange,onRun,runUnavailable,onAsk}: Props) {
  const names=useMemo(()=>Object.keys(files).sort((a,b)=>a.localeCompare(b)),[files]);
  const [selected,setSelected]=useState(initialFilename || '');
  const name=names.includes(selected)?selected:(names.find(item=>item.endsWith('.py'))||names[0]||'');
  const code=files[name]||'';
  const runBlocker=name.endsWith('.py') ? runUnavailable(name,code) : undefined;
  const [message,setMessage]=useState('');
  const [failure,setFailure]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const changed=names.filter(item=>files[item]!==originalFiles[item]);
  const total=Object.values(files).reduce((sum,value)=>sum+bytes(value),0);
  const originalSize=Object.values(originalFiles).reduce((sum,value)=>sum+bytes(value),0);
  function report(text:string,bad=false) {setMessage(text);setFailure(bad);}
  function validate(incoming:Record<string,string>) {
    const merged={...files,...incoming};
    for(const [path,text] of Object.entries(incoming)) {
      // Trusted, unmodified course files may exceed the personal-edit quota.
      if(text===originalFiles[path]) continue;
      if(!safePath(path)) throw new Error(`不支持或不安全的文件路径：${path}`);
      if(bytes(text)>FILE_LIMIT) throw new Error(`${path} 超过单文件 128 KiB 限额。`);
    }
    const size=Object.values(merged).reduce((sum,text)=>sum+bytes(text),0);
    if(size>Math.max(PROJECT_LIMIT,originalSize)) throw new Error(originalSize>PROJECT_LIMIT?'预置项目已超过远端配额，请勿继续增加文件总量；大数据文件需外部环境处理。':'有效项目文件合计超过 700 KiB，请减少内容后重试。');
  }
  function edit(value:string) {try {validate({[name]:value});onChange(name,value);if(failure)report('');}catch(error){report(error instanceof Error?error.message:'无法保存修改',true);}}
  async function upload(list:FileList|null) {
    if(!list?.length) return;
    try {
      const incoming:Record<string,string>=Object.create(null);
      for(const file of Array.from(list)) {
        if(file.size>2*1024*1024) throw new Error(`${file.name} 超过导入读取上限 2 MiB。`);
        const text=await file.text();
        let parsed:unknown;
        if(file.name.toLowerCase().endsWith('.json')) { try{parsed=JSON.parse(text);}catch{/* A text JSON file may be incomplete while being edited. */} }
        if(parsed && typeof parsed==='object' && 'format' in parsed && (parsed as {format:unknown}).format==='ai-book-project-v1') {
          const project=(parsed as {files?:unknown}).files;
          if(!project||typeof project!=='object'||Array.isArray(project)) throw new Error('项目文件格式不正确。');
          if(Object.keys(project).length>300) throw new Error('项目最多包含 300 个文件。');
          for(const [path,value] of Object.entries(project)) { if(typeof value!=='string')throw new Error(`文件 ${path} 必须是文本。`); if(!safePath(path) && value!==originalFiles[path])throw new Error(`不支持或不安全的路径：${path}`); incoming[path]=value; }
        } else {
          if(!safePath(file.name))throw new Error(`不支持上传 ${file.name}。请选择课程文本或代码文件，不能上传凭据文件。`);
          incoming[file.name]=text;
        }
      }
      validate(incoming);
      const updates=Object.entries(incoming).filter(([path,text])=>text!==files[path]);
      const overwrites=updates.filter(([path])=>Object.hasOwn(files,path));
      if(overwrites.length && !window.confirm(`导入会覆盖 ${overwrites.length} 个当前文件。继续？`))return;
      updates.forEach(([path,text])=>onChange(path,text));
      const first=Object.keys(incoming)[0];if(first)setSelected(first);
      report(updates.length?`已导入 ${updates.length} 个文件，修改将随学习记录保存。`:'项目内容与当前文件一致，无需修改。');
    } catch(error) {report(error instanceof Error?error.message:'导入失败，请检查文件格式。',true);}
    finally {if(input.current)input.current.value='';}
  }
  return <section className="project-files" aria-label="项目文件">
    <header className="project-files-header"><div><FolderOpen size={16}/><strong>本章项目文件</strong><span>{names.length} 份</span></div><div className="project-actions"><ExperimentDownload compact/><button onClick={()=>input.current?.click()}><Upload size={13}/>导入文件</button><button disabled={!names.length} onClick={()=>saveFile('ai-book-project.json',JSON.stringify({format:'ai-book-project-v1',files},null,2),'application/json')}><Download size={13}/>备份 JSON</button></div><input ref={input} className="project-upload" type="file" multiple accept=".py,.txt,.csv,.json,.md,.yaml,.yml,.toml,.ini,.cfg,.sh" onChange={event=>void upload(event.target.files)}/></header>
    <p className="project-quota">项目文件 {Math.ceil(total/1024)} / 700 KiB · 单文件 128 KiB · 支持代码、数据文本和项目 JSON。{originalSize>PROJECT_LIMIT&&<span> 预置项目超过 700 KiB；保留全部课程原文件，当前仅允许不增加总量的修改。大数据文件请下载，远端传输仍需专门配置。</span>}</p>
    {names.length?<div className="project-files-body"><nav className="project-file-list" aria-label="文件列表">{names.map(path=><button key={path} className={path===name?'selected':''} onClick={()=>{setSelected(path);report('');}} title={path}>{path.endsWith('.py')?<FileCode2 size={14}/>:<FileText size={14}/>}<span>{path}</span>{files[path]!==originalFiles[path]&&<i aria-label="已修改" title="已修改"/>}</button>)}</nav><div className="project-editor"><div className="project-editor-heading"><strong title={name}>{name}</strong><div><button onClick={()=>saveFile(name.split('/').pop()||'file.txt',code)} title="下载当前文件" aria-label="下载当前文件"><Download size={14}/></button><button disabled={!Object.hasOwn(originalFiles,name)||code===originalFiles[name]} onClick={()=>{if(window.confirm(`恢复 ${name} 的课程原始内容？当前修改会被覆盖。`)){onChange(name,originalFiles[name]);report('已恢复课程原始内容。');}}} title="恢复原始代码" aria-label="恢复原始代码"><RotateCcw size={14}/></button></div></div><textarea key={name} value={code} spellCheck={false} aria-label={`编辑 ${name}`} onChange={event=>edit(event.target.value)} onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();const target=event.currentTarget;const start=target.selectionStart;const end=target.selectionEnd;edit(code.slice(0,start)+'    '+code.slice(end));requestAnimationFrame(()=>{target.selectionStart=target.selectionEnd=start+4;});}}}/><footer className="project-editor-footer"><span>{code.split('\n').length} 行 · {(bytes(code)/1024).toFixed(1)} KiB{files[name]!==originalFiles[name]?' · 已修改':''}</span><div><button onClick={()=>onAsk(name,code)}><Sparkles size={13}/>解释文件</button>{name.endsWith('.py')&&<button className="project-run" disabled={!!runBlocker} title={runBlocker} onClick={()=>onRun(name,code)}><Play size={12}/>{runBlocker || '运行此文件'}</button>}</div></footer></div></div>:<p className="project-empty">本章没有附带项目文件。可以导入自己的 Python 或数据文件继续实验。</p>}
    {message&&<p className={`project-message${failure?' project-message-error':''}`} role={failure?'alert':'status'}>{message}</p>}
  </section>;
}
