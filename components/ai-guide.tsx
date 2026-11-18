'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, BookOpen, Check, ChevronDown, ExternalLink, LoaderCircle, Pin, PinOff, RotateCcw, Sparkles, Square, Trash2, X } from 'lucide-react';
import type { GuideMessage } from '@/lib/course-types';
import { GUIDE_STREAM_TYPE } from '@/lib/guide-stream';
import { readGuideAnswer } from './guide-answer';
import './ai-guide.css';

export type { GuideMessage } from '@/lib/course-types';

export type GuideContext = {
  chapterId: string;
  title: string;
  historyKey?: string;
  restore?: boolean;
  termId?: string;
  definition?: string;
  selection?: string;
  code?: string;
  error?: string;
};
function fingerprint(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${text.length}:${hash >>> 0}`;
}

type AIGuideProps = {
  context: GuideContext;
  authenticated: boolean;
  cacheScope: string;
  signInHref: string;
  seenContextSignatures: Map<string, string>;
  onIdentityChange: () => void;
  history: GuideMessage[];
  onHistory: (history: GuideMessage[]) => void;
  onClose: () => void;
  onNavigate: (chapterId: string, blockId?: string) => void;
};

function firstQuestion(context: GuideContext) {
  if (context.error) return '请结合当前代码，帮我理解这个报错，并告诉我可以怎样排查。';
  if (context.code) return '请结合本章内容，逐步解释这段代码的作用和运行过程。';
  if (context.termId) return `请结合本章正在讨论的问题，用初学者能理解的方式解释“${context.title}”。`;
  if (context.selection) return '请结合本章上下文解释我选中的这段文字。';
  return '请为我导读这一章：它在解决什么问题，应该带着哪些问题阅读，实验时需要观察什么？';
}

function readableError(status: number, payload: unknown) {
  const value = payload as { error?: string | { message?: string }; message?: string } | null;
  const detail = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message;
  const labels: Record<number, string> = {
    401: '需要登录后才能使用 AI 导读',
    403: '当前账号没有调用这个模型的权限',
    408: 'AI 请求超时',
    429: '请求过于频繁，或当前模型额度不足',
    502: '模型服务暂时没有正常响应',
    503: 'AI 服务尚未就绪',
    504: '模型响应超时',
  };
  const label = labels[status] || `AI 请求失败（${status}）`;
  return detail ? `${label}：${detail}` : label;
}

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part)}</>;
}

/** A deliberately small, safe renderer. Model text is never interpreted as HTML. */
function AnswerText({ text }: { text: string }) {
  const pieces = text.split(/(```[\s\S]*?```)/g);
  return <div className="guide-answer-text">{pieces.map((piece, index) => {
    if (piece.startsWith('```')) {
      const code = piece.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
      return <pre key={index}><code>{code}</code></pre>;
    }
    return piece.split(/\n\s*\n/).filter(Boolean).map((paragraph, paragraphIndex) => {
      const lines = paragraph.trim().split('\n');
      const key = `${index}-${paragraphIndex}`;
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={key}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*[-*]\s+/, '')} /></li>)}</ul>;
      if (lines.every(line => /^\s*\d+[.)、]\s*/.test(line))) return <ol key={key}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*\d+[.)、]\s*/, '')} /></li>)}</ol>;
      if (lines.length === 1 && /^#{1,4}\s+/.test(paragraph.trim())) return <h3 key={key}><InlineText text={paragraph.trim().replace(/^#{1,4}\s+/, '')} /></h3>;
      return <p key={key}><InlineText text={paragraph} /></p>;
    });
  })}</div>;
}

export function AIGuide({ context, authenticated, cacheScope, signInHref, seenContextSignatures, onIdentityChange, history, onHistory, onClose, onNavigate }: AIGuideProps) {
  const titleId = useId();
  const [messages, setMessages] = useState<GuideMessage[]>(history);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pinned, setPinned] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const stickToBottom = useRef(true);
  const [lastQuestion, setLastQuestion] = useState('');
  const messageRef = useRef(messages);
  const contextRef = useRef(context);
  const onHistoryRef = useRef(onHistory);
  const onCloseRef = useRef(onClose);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef<string | null>(null);
  const requestId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialFocus = useRef<HTMLElement | null>(null);
  const priorSignature = useRef<string | null>(null);
  const previousHistoryProp = useRef(history);
  const signature = `${context.chapterId}|${context.termId || ''}|${context.title}|${context.selection || ''}|${context.code || ''}|${context.error || ''}`;
  contextRef.current = context;
  onHistoryRef.current = onHistory;
  onCloseRef.current = onClose;

  function commit(next: GuideMessage[]) {
    messageRef.current = next;
    setMessages(next);
    onHistoryRef.current(next);
  }

  function stopRequest() {
    const operation = operationRef.current;
    operationRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    if (operation) void fetch('/api/guide', {
      method: 'POST', keepalive: true, headers: { 'X-Learning-Scope': cacheScope, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', requestId: operation }),
    }).catch(() => {});
  }

  function cancel() {
    requestId.current += 1;
    stopRequest();
    setBusy(false);
    setDraft('');
    setNotice('已停止回答，可继续提问。');
  }

  async function ask(question: string, retry = false) {
    const cleanQuestion = question.trim();
    if (!cleanQuestion || !authenticated) return;
    stopRequest();
    const thisRequest = ++requestId.current;
    const controller = new AbortController();
    const operation = crypto.randomUUID();
    operationRef.current = operation;
    abortRef.current = controller;
    const current = contextRef.current;
    let previous = messageRef.current;
    if (retry && previous.at(-1)?.role === 'user' && previous.at(-1)?.content === cleanQuestion) previous = previous.slice(0, -1);
    const pending: GuideMessage[] = [...previous.slice(-99), { role: 'user', content: cleanQuestion }];
    commit(pending);
    stickToBottom.current = true;
    setDraft('');
    setLastQuestion(cleanQuestion);
    setError('');
    setNotice('');
    setBusy(true);
    setInput('');
    let timedOut = false;
    const timer = window.setTimeout(() => { if (thisRequest === requestId.current) { timedOut = true; stopRequest(); } }, 65000);
    try {
      const response = await fetch('/api/guide', {
        method: 'POST',
        headers: { 'X-Learning-Scope': cacheScope, 'Content-Type': 'application/json', Accept: GUIDE_STREAM_TYPE },
        signal: controller.signal,
        body: JSON.stringify({
          requestId: operation,
          chapterId: current.chapterId,
          termId: current.termId,
          selection: current.selection,
          question: cleanQuestion,
          history: previous.slice(-6).map(({ role, content }) => ({role, content: content.slice(0, 1500)})),
          code: current.code,
          error: current.error,
        }),
      });
      if (!response.ok) {
        const reason = await response.json().catch(() => null) as { code?: string } | null;
        if (response.status === 401 || reason?.code === 'identity_changed') { onIdentityChange(); return; }
        throw new Error(readableError(response.status, reason));
      }
      const answer = await readGuideAnswer(response, partial => {
        if (thisRequest === requestId.current) setDraft(partial);
      });
      if (thisRequest !== requestId.current) return;
      commit([...pending, answer].slice(-100));
    } catch (problem) {
      if (thisRequest !== requestId.current) return;
      if (timedOut) setError('AI 请求超过 65 秒，已停止等待。可以稍后重试。');
      else if (controller.signal.aborted) setNotice('已停止这次请求。');
      else setError(problem instanceof Error ? problem.message : '暂时无法连接 AI 服务，请检查网络后重试。');
    } finally {
      window.clearTimeout(timer);
      if (thisRequest === requestId.current) {
        setBusy(false);
        setDraft('');
        abortRef.current = null;
        operationRef.current = null;
      }
    }
  }

  useEffect(() => {
    initialFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus({ preventScroll: true });
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', escape);
    return () => {
      requestId.current += 1;
      stopRequest();
      document.removeEventListener('keydown', escape);
      initialFocus.current?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const contextIdentity = contextRef.current.historyKey || `${contextRef.current.chapterId}:${contextRef.current.termId || (contextRef.current.code ? 'code' : contextRef.current.selection?.slice(0, 70) || 'chapter')}`;
    const contextFingerprint = fingerprint(signature);
    const prior = priorSignature.current || seenContextSignatures.get(contextIdentity);
    const contextChanged = Boolean(prior && prior !== contextFingerprint);
    priorSignature.current = contextFingerprint;
    seenContextSignatures.set(contextIdentity, contextFingerprint);
    if (seenContextSignatures.size > 150) seenContextSignatures.delete(seenContextSignatures.keys().next().value!);
    requestId.current += 1;
    stopRequest();
    messageRef.current = history;
    setMessages(history);
    setDraft('');
    setError('');
    setNotice('');
    setInput('');
    setBusy(false);
    setLastQuestion(history.at(-1)?.role === 'user' ? history.at(-1)!.content : '');
    if (authenticated && !contextRef.current.restore && (history.length === 0 || contextChanged)) {
      const timer = window.setTimeout(() => void ask(firstQuestion(contextRef.current)), 0);
      return () => window.clearTimeout(timer);
    }
    // History updates belong to this open conversation; only a new context starts a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, authenticated]);

  useEffect(() => {
    if (history === previousHistoryProp.current) return;
    previousHistoryProp.current = history;
    const local = messageRef.current;
    if (history === local || (history.length === local.length && JSON.stringify(history) === JSON.stringify(local))) return;
    // Deleting or restoring records elsewhere must also update an already-open
    // panel; an in-flight answer must not recreate a conversation just deleted.
    requestId.current += 1;
    stopRequest();
    messageRef.current = history;
    setMessages(history);
    setBusy(false);
    setError('');
    setNotice('');
    setDraft('');
    setLastQuestion(history.at(-1)?.role === 'user' ? history.at(-1)!.content : '');
  }, [history]);

  useEffect(() => {
    if (scrollRef.current && stickToBottom.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, error, draft]);

  function clearConversation() {
    requestId.current += 1;
    stopRequest();
    setBusy(false);
    setError('');
    setDraft('');
    setNotice('此处的导读对话已清空。');
    setLastQuestion('');
    commit([]);
    inputRef.current?.focus();
  }

  return <aside className={`guide-panel${authenticated ? '' : ' guide-panel--local'}${pinned ? ' guide-panel--pinned' : ''}${collapsed ? ' guide-panel--collapsed' : ''}`} role="dialog" aria-label={collapsed ? context.title : undefined} aria-labelledby={collapsed ? undefined : titleId} aria-modal="false">
    <header className="guide-panel-header">
      <span className="guide-panel-eyebrow"><Sparkles size={15} strokeWidth={1.6} /> {collapsed ? context.title : '书旁导读'}</span>
      <div className="guide-header-actions">
        <button type="button" className="guide-icon-button guide-pin" onClick={() => setPinned(value => !value)} aria-label={pinned ? '取消固定导读面板' : '固定导读面板'} title={pinned ? '取消固定' : '固定到侧边'} aria-pressed={pinned}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <button type="button" className="guide-icon-button guide-collapse" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed} aria-label={collapsed ? '展开导读' : '收起导读'}><ChevronDown size={17}/></button>
        <button type="button" className="guide-icon-button" onClick={onClose} aria-label="关闭 AI 导读" title="关闭（Esc）"><X size={19} /></button>
      </div>
    </header>
    <div className="guide-panel-title"><h2 id={titleId} ref={headingRef} tabIndex={-1}>{context.title}</h2></div>
    <div className="guide-panel-scroll" ref={scrollRef} onScroll={e => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
      {context.definition && <section className="guide-definition"><div className="guide-section-label"><BookOpen size={13} /> {context.termId ? '课程释义' : '章节简介'}</div><p>{context.definition}</p></section>}
      {(context.selection || context.code || context.error) && <details className="guide-context"><summary>这次提问附带的内容 <ChevronDown size={13} /></summary>{context.selection && <blockquote>{context.selection}</blockquote>}{context.code && <pre><code>{context.code}</code></pre>}{context.error && <pre className="guide-context-error">{context.error}</pre>}</details>}
      <div className="guide-conversation">
        {messages.map((message, index) => <article key={index} className={`guide-message guide-message--${message.role}`}>
          <div className="guide-section-label">{message.role === 'assistant' ? <><Sparkles size={12} /> AI 解答{message.model && <small>{message.model}</small>}</> : '我的问题'}</div>
          {message.role === 'assistant' ? <AnswerText text={message.content} /> : <p>{message.content}</p>}
          {message.role === 'assistant' && Boolean(message.sources?.length) && <div className="guide-sources"><span>回到书中原文</span>{message.sources!.map((source, sourceIndex) => <button key={`${source.chapterId}-${source.blockId}-${sourceIndex}`} type="button" title={source.excerpt || source.title} onClick={() => { onNavigate(source.chapterId, source.blockId); if (window.matchMedia('(max-width: 1099px)').matches) setCollapsed(true); else if (!pinned) onClose(); }}><BookOpen size={12} /><span>{source.title}</span><ExternalLink size={11} /></button>)}</div>}
        </article>)}
        {busy && draft && <article className="guide-message guide-message--assistant"><div className="guide-section-label"><Sparkles size={12}/> AI 解答</div><AnswerText text={draft}/></article>}
        {busy && <div className="guide-loading" role="status"><LoaderCircle className="guide-spin" size={16} /><span>{draft ? '正在回答…' : '正在阅读本章…'}</span><button type="button" onClick={cancel}><Square size={11} /> 停止</button></div>}
        {error && <div className="guide-error" role="alert"><p>{error}</p><button type="button" onClick={() => void ask(lastQuestion || firstQuestion(context), true)}><RotateCcw size={13} /> 重新请求</button></div>}
        {notice && <div className="guide-notice" role="status"><Check size={13} /><span>{notice}</span></div>}
        {authenticated && !busy && !error && !notice && messages.at(-1)?.role === 'user' && lastQuestion && <button className="guide-resume" type="button" onClick={() => void ask(lastQuestion, true)}><RotateCcw size={13} /> 继续上次提问</button>}
        {authenticated && !messages.length && !busy && !error && <p className="guide-empty">从一个具体问题开始，也可以请我带你读这一章。</p>}
      </div>
    </div>
    {authenticated ? <footer className="guide-panel-footer">
      <div className="guide-followups"><button type="button" disabled={busy} onClick={() => void ask('请说得更简单一些，尽量只用本章已经出现的概念。')}>说得更简单</button><button type="button" disabled={busy} onClick={() => void ask('请给我一个贴近生活的小例子，并联系当前章节说明。')}>举个例子</button>{context.code && <button type="button" disabled={busy} onClick={() => void ask('请结合我这段代码，具体说明这个概念。')}>结合代码</button>}</div>
      <form className="guide-input-wrap" onSubmit={event => { event.preventDefault(); if (!busy) void ask(input); }}>
        <textarea ref={inputRef} value={input} onChange={event => setInput(event.target.value)} rows={2} maxLength={1800} placeholder="还有哪里没想明白？" aria-label="向 AI 导读继续提问" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void ask(input); } }} />
        <button className="guide-send" type="submit" disabled={busy || !input.trim()} aria-label="发送问题"><ArrowUp size={18} /></button>
      </form>
      <div className="guide-footer-note"><span>可对照书中原文核实</span>{messages.length > 0 && <button type="button" onClick={clearConversation} aria-label="清空当前导读对话" title="清空这段对话"><Trash2 size={12} /></button>}</div>
    </footer> : <footer className="guide-panel-footer guide-local-note"><a href={signInHref}>登录后向 AI 提问</a></footer>}
  </aside>;
}
