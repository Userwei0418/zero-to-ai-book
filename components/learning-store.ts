'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LearningState } from '@/lib/course-types';
import { guideMessage } from '@/lib/guide-message';
import { saveLearningCache, selectLearningSnapshot, type LearningCache as Cache, type LearningSnapshot as Snapshot } from '@/lib/learning-cache';

const CACHE_KEY = 'ai-book-learning-v1';
export type SaveStatus = 'loading' | 'saved' | 'saving' | 'local' | 'conflict' | 'unsaved';
const defaults: LearningState = { fontSize: 18, reduceMotion: false, bookmarks: [], codes: {}, videoTimes: {}, chats: {}, predictions: {} };


export function normalizeLearningState(value: unknown): LearningState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: LearningState = {};
  if (typeof input.chapterId === 'string') output.chapterId = input.chapterId.slice(0, 160);
  if (typeof input.anchor === 'string') output.anchor = input.anchor.slice(0, 240);
  if (typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)) output.fontSize = Math.max(16, Math.min(24, Math.round(input.fontSize)));
  if (typeof input.reduceMotion === 'boolean') output.reduceMotion = input.reduceMotion;
  if (Array.isArray(input.bookmarks)) output.bookmarks = input.bookmarks.filter((item): item is NonNullable<LearningState['bookmarks']>[number] => Boolean(item && typeof item === 'object' && typeof item.chapterId === 'string' && typeof item.blockId === 'string' && typeof item.title === 'string' && typeof item.savedAt === 'string')).slice(0, 2000);
  for (const key of ['codes', 'predictions'] as const) {
    const values = input[key];
    if (values && typeof values === 'object' && !Array.isArray(values)) output[key] = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 2000).map(([id, content]) => [id, content.slice(0, 180000)]));
  }
  if (input.files && typeof input.files === 'object' && !Array.isArray(input.files)) {
    output.files = Object.create(null);
    for (const [chapter, files] of Object.entries(input.files).slice(0, 100)) {
      if (['__proto__', 'constructor', 'prototype'].includes(chapter) || !/^[a-zA-Z0-9_-]{1,160}$/.test(chapter) || !files || typeof files !== 'object' || Array.isArray(files)) continue;
      let bytes = 0; const safe: Record<string, string> = Object.create(null);
      for (const [path, content] of Object.entries(files).slice(0, 250)) {
        if (typeof content !== 'string' || path.length > 200 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(segment => !segment || segment === '.' || segment === '..' || ['__proto__', 'constructor', 'prototype'].includes(segment)) || !/\.(py|txt|csv|json|md|yaml|yml|toml|ini|cfg|sh)$/i.test(path)) continue;
        const size = new TextEncoder().encode(content).length;
        if (size > 128 * 1024 || bytes + size > 700 * 1024) continue;
        safe[path] = content; bytes += size;
      }
      output.files![chapter] = safe;
    }
  }
  if (input.videoTimes && typeof input.videoTimes === 'object' && !Array.isArray(input.videoTimes)) output.videoTimes = Object.fromEntries(Object.entries(input.videoTimes).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0).slice(0, 1000));
  if (input.chats && typeof input.chats === 'object' && !Array.isArray(input.chats)) output.chats = Object.fromEntries(Object.entries(input.chats).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1])).slice(0, 1000).map(([id, messages]) => [id, messages.slice(-100).flatMap(guideMessage)]));
  return output;
}

export function useLearningStore() {
  const [state, setState] = useState<LearningState>(defaults);
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [cacheScope, setCacheScope] = useState('pending');
  const scope = useRef('pending');
  const scopeVerified = useRef(false);
  const accountVerified = useRef(false);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState('');
  const [change, setChange] = useState(0);
  const current = useRef<LearningState>(defaults);
  const revision = useRef(0);
  const version = useRef(0);
  const saving = useRef(false);
  const conflicted = useRef(false);
  const deleting = useRef(false);
  const remote = useRef<{state: LearningState; revision: number} | null>(null);
  const cache = useCallback((dirty: boolean) => {
    let written = false;
    try { written = saveLearningCache(localStorage, `${CACHE_KEY}:${scope.current}`, { state: current.current, revision: revision.current, dirty, savedAt: new Date().toISOString() }); } catch { /* Storage can itself be blocked. */ }
    if (!written) { setStatus('unsaved'); setError('本机保存失败：浏览器空间不足或不允许存储。当前修改仍在页面中，请先导出学习记录。'); }
    return written;
  }, []);

  useEffect(() => {
    let disposed = false;
    fetch('/api/state').then(async response => {
      if (!response.ok) throw new Error('学习记录服务暂时不可用');
      const data = await response.json() as Snapshot;
      if (disposed) return;
      scope.current = data.cacheScope || 'anonymous';
      scopeVerified.current = true;
      setCacheScope(scope.current);
      setAuthenticated(Boolean(data.authenticated));
      accountVerified.current = Boolean(data.authenticated);
      let local: Cache | null = null;
      try { local = JSON.parse(localStorage.getItem(`${CACHE_KEY}:${scope.current}`) || 'null'); } catch { /* Empty or unreadable cache. */ }
      try { localStorage.setItem(`${CACHE_KEY}:active-scope`, scope.current); } catch { /* A full store must not prevent reading the existing draft. */ }
      remote.current = { state: data.state || {}, revision: data.revision || 0 };
      const restored = selectLearningSnapshot(data, local);
      if (restored.mode === 'device') {
        current.current = { ...defaults, ...normalizeLearningState(restored.state) };
        revision.current = 0;
        setState(current.current);
        if (cache(true)) { setStatus('local'); setError(''); }
      } else if (restored.mode === 'pending' || restored.mode === 'conflict') {
        current.current = { ...defaults, ...normalizeLearningState(restored.state) };
        revision.current = restored.revision;
        setState(current.current);
        if (restored.mode === 'conflict') {
          conflicted.current = true;
          setStatus('conflict');
          setError('本机有尚未同步的修改，服务器也有更新。两份记录均已保留，请选择要继续使用的一份。');
        } else { setStatus('local'); setChange(n => n + 1); }
      } else {
        current.current = { ...defaults, ...normalizeLearningState(restored.state) };
        revision.current = restored.revision;
        setState(current.current);
        cache(false);
        setStatus('saved');
      }
    }).catch(cause => {
      if (!disposed) {
        // Offline restoration stays in the last verified account's partition. It is
        // never uploaded until that identity has been verified again.
        try {
          scope.current = localStorage.getItem(`${CACHE_KEY}:active-scope`) || 'offline';
          setCacheScope(scope.current);
          const local = JSON.parse(localStorage.getItem(`${CACHE_KEY}:${scope.current}`) || 'null') as Cache | null;
          if (local?.state) { current.current = { ...defaults, ...normalizeLearningState(local.state) }; revision.current = local.revision; setState(current.current); }
        } catch { /* A blocked cache does not prevent reading. */ }
        setStatus('local'); setError(`${cause.message}；修改会保留在本机，联网后可重试同步。`);
      }
    }).finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [cache]);

  const update = useCallback((patch: Partial<LearningState> | ((previous: LearningState) => LearningState)) => {
    current.current = typeof patch === 'function' ? patch(current.current) : { ...current.current, ...patch };
    version.current++;
    setState(current.current);
    const cached = cache(true);
    if (!conflicted.current && cached) {
      setStatus(accountVerified.current ? 'saving' : 'local');
      if (scopeVerified.current && !accountVerified.current) setError('');
    }
    setChange(n => n + 1);
  }, [cache]);

  const sync = useCallback(async () => {
    if (saving.current || conflicted.current || deleting.current) return;
    if (scopeVerified.current && !accountVerified.current) {
      if (cache(true)) { setStatus('local'); setError(''); }
      return;
    }
    saving.current = true;
    const sentVersion = version.current;
    setStatus('saving');
    try {
      if (!scopeVerified.current) {
        const verifiedResponse = await fetch('/api/state');
        if (!verifiedResponse.ok) throw new Error('尚未能确认当前账号，已暂停同步');
        const verified = await verifiedResponse.json() as Snapshot;
        if (verified.cacheScope !== scope.current) throw new Error('登录账号发生变化，请刷新页面读取当前账号的记录。原账号的本机副本已保留');
        scopeVerified.current = true;
        setAuthenticated(Boolean(verified.authenticated));
        accountVerified.current = Boolean(verified.authenticated);
        if (!verified.authenticated) {
          if (cache(true)) { setStatus('local'); setError(''); }
          return;
        }
        if (verified.revision !== revision.current) {
          remote.current = { state: verified.state || {}, revision: verified.revision };
          conflicted.current = true; setStatus('conflict'); setError('服务器上有更新的记录，请选择保留本机记录或加载服务器记录。'); return;
        }
      }
      const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: current.current, revision: revision.current, cacheScope: scope.current }) });
      if (response.status === 409) {
        const conflict = await response.json() as { code?: string };
        if (conflict.code === 'identity_changed') { scopeVerified.current = false; throw new Error('登录账号发生变化，请刷新页面。原账号的本机副本已保留'); }
        const latest = await fetch('/api/state').then(r => r.json()) as {state: LearningState; revision: number};
        remote.current = { state: latest.state, revision: latest.revision };
        conflicted.current = true;
        setStatus('conflict');
        setError('另一个设备更新了学习记录。未覆盖任何代码，请选择保留本机记录或加载服务器记录。');
        return;
      }
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as {error?: string}; throw new Error(payload.error || '服务器保存失败'); }
      const data = await response.json() as {state?: LearningState; revision: number; authenticated?: boolean};
      revision.current = data.revision;
      if (sentVersion === version.current) { cache(false); setStatus('saved'); setError(''); }
      else { cache(true); setChange(n => n + 1); }
    } catch (cause) {
      if (cache(true)) {
        setStatus('local');
        setError(`${cause instanceof Error ? cause.message : '连接中断'}；已保留本机恢复副本。`);
      }
    } finally { saving.current = false; }
  }, [cache]);

  useEffect(() => {
    if (!ready || !change || conflicted.current) return;
    const timer = setTimeout(() => { void sync(); }, 900);
    return () => clearTimeout(timer);
  }, [change, ready, sync]);

  useEffect(() => {
    const online = () => { if (!conflicted.current) void sync(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [sync]);

  const resolveConflict = useCallback((useLocal: boolean) => {
    if (!remote.current) return;
    try { localStorage.setItem(`${CACHE_KEY}:${scope.current}:conflict-${Date.now()}`, JSON.stringify({ local: current.current, remote: remote.current })); } catch { /* Preserve primary cache. */ }
    revision.current = remote.current.revision;
    conflicted.current = false;
    setError('');
    if (useLocal) { setChange(n => n + 1); setStatus('saving'); }
    else { current.current = { ...defaults, ...normalizeLearningState(remote.current.state) }; setState(current.current); cache(false); setStatus('saved'); return current.current; }
  }, [cache]);

  const deleteRecords = useCallback(async () => {
    deleting.current = true;
    setStatus('saving');
    try {
      while (saving.current) await new Promise(resolve => setTimeout(resolve, 50));
      const response = await fetch('/api/state', { method: 'DELETE', headers: { 'X-Learning-Scope': scope.current } });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as {error?: string}; throw new Error(payload.error || '服务器删除失败，请稍后重试'); }
      current.current = { ...defaults };
      revision.current = 0;
      version.current++;
      conflicted.current = false;
      setState(current.current);
      setChange(0);
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      keys.forEach(key => { if (key?.startsWith(`${CACHE_KEY}:${scope.current}`) || key?.startsWith(`ai-book-results-v1:${scope.current}:`)) localStorage.removeItem(key); });
      setError('');
      setStatus('saved');
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败，原记录仍保留。');
      setStatus('local');
      return false;
    } finally { deleting.current = false; }
  }, []);

  return { state, update, ready, status, error, authenticated, cacheScope, sync, resolveConflict, deleteRecords };
}
