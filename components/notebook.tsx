'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, Download, FileCode2, ListRestart, LoaderCircle, Maximize2, Play, RotateCcw, Sparkles, Square } from 'lucide-react';
import './notebook.css';
import type { CourseBlock } from '@/lib/course-types';
import { browserRunnable, getNotebookKernel, type NotebookKernel, type RegisteredCell } from '@/lib/notebook-runtime';

const NotebookContext = createContext<NotebookKernel | null>(null);
const NotebookSaveContext = createContext<{ label?: string; issue?: boolean }>({});

export function NotebookProvider({ chapterId, files, originalFiles, cells, cacheScope, remoteRuntimeConfigured, gpuConfigured, saveLabel, saveIssue, children }: {
  chapterId: string;
  files?: Record<string, string>;
  originalFiles?: Record<string, string>;
  cells?: RegisteredCell[];
  cacheScope?: string;
  remoteRuntimeConfigured?: boolean;
  gpuConfigured?: boolean;
  saveLabel?: string;
  saveIssue?: boolean;
  children: ReactNode;
}) {
  const kernel = useMemo(() => getNotebookKernel(chapterId, cacheScope), [chapterId, cacheScope]);
  useEffect(() => {
    kernel.setFiles(files);
    kernel.setExportOriginals(originalFiles);
    kernel.setRemoteConfigured(remoteRuntimeConfigured, gpuConfigured);
    if (cells) kernel.registerAll(cells);
    kernel.hydrate();
  }, [kernel, files, originalFiles, cells, remoteRuntimeConfigured, gpuConfigured]);
  return <NotebookContext.Provider value={kernel}><NotebookSaveContext.Provider value={{ label: saveLabel, issue: saveIssue }}>{children}</NotebookSaveContext.Provider></NotebookContext.Provider>;
}

export function ExperimentDownload({ format = 'zip', compact = false }: { format?: 'zip' | 'py' | 'ipynb'; compact?: boolean }) {
  const kernel = useContext(NotebookContext);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  if (!kernel) return null;
  const label = format === 'zip' ? (compact ? '下载实验包' : '实验项目 .zip') : format === 'py' ? 'Python 脚本 .py' : 'Notebook .ipynb';
  return <>
    <button type="button" disabled={downloading} onClick={async event => {
      const menu = event.currentTarget.closest('details');
      setDownloading(true);
      setError('');
      try {
        await kernel.download(format);
        if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '下载失败，请重试。');
      } finally { setDownloading(false); }
    }} title={format === 'zip' ? '下载当前代码、依赖文件和运行说明' : label}>
      {downloading ? <LoaderCircle size={13}/> : format === 'zip' ? <Download size={13}/> : <FileCode2 size={13}/>}
      {downloading ? '准备下载…' : label}
    </button>
    {error && <span role="alert" className="notebook-download-error">{error}</span>}
  </>;
}

export function NotebookToolbar({ onExpand }: { onExpand?: () => void }) {
  const kernel = useContext(NotebookContext);
  if (!kernel) return null;
  return <Toolbar kernel={kernel} onExpand={onExpand} />;
}

function Toolbar({ kernel, onExpand }: { kernel: NotebookKernel; onExpand?: () => void }) {
  const state = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
  const busy = Boolean(state.activeCell || state.batch);
  const saved = useContext(NotebookSaveContext);
  const batchBlocked = kernel.sequenceUnavailable();
  const hasHistory = Object.values(state.results).some(result => result.historical);
  return <div className="notebook-toolbar" aria-label="本章代码工具">
    <div className="notebook-kernel-state" title={state.message}>
      <span className={`notebook-status-dot ${busy ? 'notebook-status-active' : state.phase === 'error' ? 'notebook-status-error' : ''}`} />
      <span>{state.phase === 'loading' ? '正在启动 Python' : busy ? 'Python 运行中' : state.environment === 'remote' ? '本章云端 Python' : state.environment === 'split' ? '浏览器 / 云端' : state.phase === 'idle' ? '浏览器 Python 按需启动' : '本章浏览器 Python'}{state.count > 0 ? ` [${state.count}]` : ''}</span>
    </div>
    <div className="notebook-toolbar-actions">
      <button type="button" onClick={() => void kernel.runAll()} disabled={busy || !!batchBlocked} title={batchBlocked || "清空变量，然后按顺序执行本章当前代码"}><Play size={13} />从头运行本章</button>
      {busy ? <button type="button" onClick={() => kernel.stop()} className="notebook-stop"><Square size={12} />停止执行</button> : <button type="button" onClick={() => void kernel.reset()} title="清空本章所有 Python 变量；保留代码修改与历史输出"><RotateCcw size={13} />重置环境</button>}
      <details className="notebook-download">
        <summary title="下载本章所有代码"><Download size={13} /><span>下载</span><ChevronDown size={11} /></summary>
        <div className="notebook-download-menu">
          <ExperimentDownload />
          <ExperimentDownload format="ipynb" />
          <ExperimentDownload format="py" />
        </div>
      </details>
      {onExpand && <button type="button" onClick={onExpand} className="notebook-expand"><Maximize2 size={13} />展开实验</button>}
    </div>
    <div className="notebook-session-summary" role="status" aria-live="polite"><span>{state.message}</span>{state.batchProgress && <span className="notebook-batch-progress">已完成 {state.batchProgress.completed} / {state.batchProgress.total} 个单元</span>}</div>
    <div className="notebook-session-help">同章单元共享变量，翻页和展开实验均可接着运行。重置环境会清空变量，保留代码修改。</div>
    {hasHistory && !busy && <div className="notebook-history-notice"><ListRestart size={15}/><div><strong>已恢复历史结果，部分变量需要重新执行。</strong><span>用当前保存的代码“从头运行本章”，或在目标单元运行前置单元。API 实验重跑会再次调用服务。</span></div></div>}
    {saved.label && <div className={`notebook-save-state${saved.issue ? ' notebook-save-issue' : ''}`} role="status">代码修改：{saved.label}</div>}
    {batchBlocked && <div className="notebook-session-boundary">{batchBlocked}。整章顺序运行暂不可用，可单独运行浏览器单元，或下载本章。</div>}
    {state.environment === 'remote' && <div className="notebook-session-boundary">本章普通 Python 共享云端会话，GPU 会话独立。</div>}
    {state.persistenceError && <div className="notebook-cache-warning" role="status">{state.persistenceError}</div>}
  </div>;
}

export function NotebookCell({ block, chapterId, value, onChange, onAsk, onExpand, expanded: expandedByParent = false }: {
  block: CourseBlock;
  chapterId: string;
  value: string;
  onChange: (value: string) => void;
  onAsk?: (code: string, error?: string) => void;
  onExpand?: () => void;
  expanded?: boolean;
}) {
  const provider = useContext(NotebookContext);
  const saved = useContext(NotebookSaveContext);
  const kernel = useMemo(() => provider || getNotebookKernel(chapterId), [provider, chapterId]);
  const state = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
  const result = state.results[block.id];
  const busy = Boolean(state.activeCell || state.batch);
  const running = state.activeCell === block.id;
  const runnable = browserRunnable(block);
  // A restored session has no live variables. File hydration can mark inputs as
  // changed, but that must not mislabel a saved result as an edit made this visit.
  const stale = Boolean(result && !result.historical && (result.code !== value || result.inputsChanged));
  const [copied, setCopied] = useState(false);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = expandedByParent || localExpanded;
  const [restorePrompt, setRestorePrompt] = useState(false);
  const [copyError, setCopyError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, value.split('\n').length);
  const runtime = kernel.runtimeFor(block);
  const runtimeLabel = runtime === 'browser' ? 'Python · 浏览器' : runtime === 'gpu' ? 'GPU · 独立云端' : runtime === 'linux' ? 'Python · 云端' : 'API · 云端';
  const changed = value !== (block.code || '');
  const blocked = runnable ? kernel.unavailableReason(block) : undefined;
  const preceding = kernel.getPrecedingCells(block.id);
  const previousCount = preceding.length;
  const beforeBlocked = previousCount ? kernel.sequenceUnavailable(preceding) : undefined;

  useEffect(() => { kernel.register({ block, value }); kernel.hydrate(); }, [kernel, block, value]);
  useEffect(() => {
    if (running && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [running, result?.stdout, result?.stderr]);

  const run = () => { if (runnable && !busy && !blocked) void kernel.execute({ block, value }); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(''); setTimeout(() => setCopied(false), 1800); }
    catch { setCopyError('复制未成功，请选中代码后复制。'); }
  };
  const error = result?.error || result?.stderr;
  return <section className={`notebook-cell ${running ? 'notebook-cell-running' : ''} ${expanded ? 'notebook-cell-expanded' : ''}`} data-cell-id={block.id} aria-label={`${block.filename || 'Python'} 代码练习`}>
    <div className="notebook-cell-heading">
      <div className="notebook-cell-label"><FileCode2 size={13} /><span>{block.filename || runtimeLabel}</span>{block.filename && <span className="notebook-runtime-label">{runtimeLabel}</span>}</div>
      <div className="notebook-cell-tools">
        {changed && <span className="notebook-stale">已修改</span>}
        {changed && <button type="button" disabled={running} className="notebook-icon-button" onClick={() => setRestorePrompt(true)} title="恢复课程原始代码" aria-label="恢复课程原始代码"><RotateCcw size={13}/></button>}
        <button type="button" className="notebook-icon-button" onClick={() => void copy()} title="复制代码" aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
        {!expandedByParent && <button type="button" className="notebook-icon-button notebook-open-workspace" onClick={onExpand || (() => setLocalExpanded(!localExpanded))} title={onExpand ? '展开到实验工作区' : expanded ? '收起单元' : '展开单元'} aria-label={onExpand ? '展开到实验工作区' : expanded ? '收起单元' : '展开单元'} aria-expanded={expanded}><Maximize2 size={13} /><span>{onExpand ? '展开' : expanded ? '收起' : '展开'}</span></button>}
      </div>
    </div>
    {restorePrompt && <div className="notebook-restore-prompt" role="alert"><span>恢复课程原始代码将覆盖这个单元的修改，历史输出保留。</span><div><button type="button" onClick={() => setRestorePrompt(false)}>保留修改</button><button type="button" onClick={() => { onChange(block.code || ''); setRestorePrompt(false); }}>恢复原始代码</button></div></div>}
    <div className="notebook-editor-wrap">
      <pre className="notebook-line-numbers" ref={gutter} aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')}</pre>
      <textarea
        ref={editor}
        className="notebook-editor"
        aria-label={`${block.filename || 'Python'} 代码编辑器`}
        value={value}
        onChange={event => onChange(event.target.value)}
        onScroll={event => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); }
          if (event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            const start = event.currentTarget.selectionStart;
            const end = event.currentTarget.selectionEnd;
            onChange(value.slice(0, start) + '    ' + value.slice(end));
            requestAnimationFrame(() => editor.current?.setSelectionRange(start + 4, start + 4));
          }
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        style={{ height: expanded ? Math.min(688, Math.max(240, lineCount * 22 + 28)) : Math.min(160, Math.max(72, lineCount * 22 + 28)) }}
      />
    </div>
    {expanded && <div className="notebook-cell-secondary"><span className={saved.issue ? 'notebook-save-issue' : ''}>{saved.label ? `代码修改：${saved.label}` : '修改随学习记录自动保存'}</span>{runnable && previousCount > 0 && <button type="button" disabled={busy || !!beforeBlocked} onClick={() => void kernel.runBefore(block.id)} title={beforeBlocked || "重置变量并按顺序运行前置单元"}><ListRestart size={13}/>运行前置单元 ({previousCount})</button>}</div>}
    <div className="notebook-cell-actions">
      <div className="notebook-run-group">
        {!blocked && <span className="notebook-execution-count" title={result?.historical ? '历史输出；刷新或重置后需要重新运行以恢复变量' : '本章执行序号'}>[{running ? '*' : result?.executionCount ?? ' '}]</span>}
        {blocked && !running ? <><span className="notebook-readonly-label">{blocked}</span><ExperimentDownload compact /></> : runnable ? <button type="button" className={`notebook-run ${running ? 'notebook-run-stop' : ''}`} disabled={busy && !running} onClick={running ? () => kernel.stop() : run}>{running ? <Square size={12} /> : <Play size={12} fill="currentColor" />}{running ? '停止' : '运行'}</button> : <span className="notebook-readonly-label">{block.reason || '示例代码 · 可编辑与下载'}</span>}
        {runnable && !blocked && !running && <span className="notebook-shortcut">Shift ↵</span>}
        {running && <span className="notebook-running-label"><LoaderCircle size={12} className="notebook-spin" />{state.phase === 'loading' ? '首次加载中…' : '执行中…'}</span>}
      </div>
      {onAsk && <button type="button" className="notebook-ask" onClick={() => onAsk(value, result?.status === 'error' ? error : undefined)}><Sparkles size={13} />{result?.status === 'error' ? '帮我调试' : '问问老师'}</button>}
    </div>
    {copyError && <div className="notebook-inline-note" role="status">{copyError}</div>}
    {result && <div className={`notebook-output-wrap ${result.status === 'error' || result.status === 'interrupted' ? 'notebook-output-error' : ''}`}>
      <div className="notebook-output-heading"><span>{stale ? '修改前的结果' : result.historical ? '历史运行结果' : '本次运行结果'}{result.runtime === 'browser' ? ' · 浏览器' : result.runtime === 'gpu' ? ' · GPU' : result.runtime ? ' · 云端' : ''}</span><span>{result.elapsedMs !== undefined ? `${(result.elapsedMs / 1000).toFixed(2)} 秒` : running ? '运行中' : ''}</span></div>
      {(stale || result.historical) && <div className="notebook-result-notice" title={stale ? '代码或依赖已修改，下面保留修改前的输出。请重新运行。' : '这是保存的历史输出，不代表变量仍在。请重新运行所需单元。'}>{expanded ? (stale ? '代码或依赖已修改，请重新运行。下面保留修改前的输出。' : '这是保存的历史输出，不代表变量仍在。请重新运行所需单元。') : stale ? '代码或依赖已修改，请重新运行。' : '历史结果 · 变量需要重新执行恢复'}</div>}
      <div className="notebook-output" ref={output} aria-live="polite" aria-atomic="false">
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre className="notebook-stderr">{result.stderr}</pre>}
        {result.error && <pre className="notebook-error-text">{result.error}</pre>}
        {result.images.map((image, index) => <img key={index} src={image} alt={`Python 生成的图表 ${index + 1}`} className="notebook-plot" />)}
        {result.tables?.map((table, index) => <div className="notebook-result-table" key={index}><table aria-label={`Python 生成的表格 ${index + 1}`}><thead><tr>{table.columns.map((column, columnIndex) => <th key={columnIndex} scope="col">{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{table.columns.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}</tr>)}</tbody></table>{table.truncated && <p>表格超过显示上限，已截断。</p>}</div>)}
        {result.mediaOmitted && <p className="notebook-output-empty">本次历史记录未保留较大的图像。重新运行可以生成图像，或运行后下载 Notebook 留存。</p>}
        {!result.stdout && !result.stderr && !result.error && !result.images.length && !result.tables?.length && !result.mediaOmitted && <p className="notebook-output-empty">{running ? (state.phase === 'loading' ? '正在下载并启动真实 Python 环境，首次需要稍等…' : '代码正在运行…') : '运行完成，无文本输出。'}</p>}
      </div>
      {result.status === 'error' && /(?:NameError|ModuleNotFoundError)/.test(error || '') && previousCount > 0 && <div className="notebook-dependency-help"><span>可能缺少前面的变量、函数或项目依赖；请先查看上方原始报错。</span><button type="button" disabled={busy || !!beforeBlocked} title={beforeBlocked} onClick={() => void kernel.runBefore(block.id)}><ListRestart size={13}/>运行前置单元</button></div>}
    </div>}
  </section>;
}
