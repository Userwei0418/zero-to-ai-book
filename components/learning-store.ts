'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LearningState } from '@/lib/course-types';
import { guideMessage } from '@/lib/guide-message';
import { hasServerRecords, saveLearningCache, selectLearningSnapshot, type LearningCache as Cache, type ReaderSession } from '@/lib/learning-cache';

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

export function readLocalDraft(): LearningState | null {
  try {
    const local = JSON.parse(localStorage.getItem(`${CACHE_KEY}:anonymous`) || 'null') as Cache | null;
    if (local?.state && Object.keys(local.state).length) return normalizeLearningState(local.state);
  } catch { /* Browsers can block storage. */ }
  return null;
}

export function useLearningStore(session: ReaderSession | null, recheck: () => void) {
  const cacheScope = session?.scope || 'pending';
  const authenticated = session?.snapshot.authenticated === true;
  const canUseServer = !!session?.verified && hasServerRecords(session.snapshot);
  const guest = canUseServer && session?.snapshot.identityKind === 'guest';
  const initial = useRef(session);
  const [state, setState] = useState<LearningState>(defaults);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState('');
  const [change, setChange] = useState(0);
  const current = useRef<LearningState>(defaults);
  const revision = useRef(0);
  const version = useRef(0);
  const saving = useRef(false);
  const conflicted = useRef(false);
  const deleting = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const remote = useRef<{state: LearningState; revision: number} | null>(null);
  const cache = useCallback((dirty: boolean) => {
    if (!lifetime.current || lifetime.current.signal.aborted) return false;
    let written = false;
    try { written = saveLearningCache(localStorage, `${CACHE_KEY}:${cacheScope}`, { state: current.current, revision: revision.current, dirty, savedAt: new Date().toISOString() }); } catch { /* Storage can itself be blocked. */ }
    if (!written) { setStatus('unsaved'); setError('本机保存失败：浏览器空间不足或不允许存储。当前修改仍在页面中，请先导出学习记录。'); }
    return written;
  }, [cacheScope]);

  useEffect(() => {
    if (!initial.current) return;
    lifetime.current = new AbortController();
    const snapshot = initial.current.snapshot;
    let local: Cache | null = null;
    try { local = JSON.parse(localStorage.getItem(`${CACHE_KEY}:${cacheScope}`) || 'null'); } catch { /* Empty or unreadable cache. */ }
    const restored = selectLearningSnapshot(snapshot, local);
    current.current = { ...defaults, ...normalizeLearningState(restored.state) };
    revision.current = restored.revision;
    setState(current.current);
    if (restored.mode === 'device') {
      setStatus('local');
    } else if (restored.mode === 'conflict') {
      remote.current = { state: snapshot.state || {}, revision: snapshot.revision };
      conflicted.current = true;
      setStatus('conflict');
      setError('本机有尚未同步的修改，服务器也有更新。两份记录均已保留，请选择要继续使用的一份。');
    } else if (restored.mode === 'pending') {
      setStatus('local'); setChange(n => n + 1);
    } else if (cache(false)) setStatus('saved');
    setReady(true);
    return () => { lifetime.current?.abort(); };
  }, [cache, cacheScope]);

  const update = useCallback((patch: Partial<LearningState> | ((previous: LearningState) => LearningState)) => {
    if (!lifetime.current || lifetime.current.signal.aborted || deleting.current) return;
    current.current = typeof patch === 'function' ? patch(current.current) : { ...current.current, ...patch };
    version.current++;
    setState(current.current);
    if (cache(true) && !conflicted.current) {
      setStatus(canUseServer ? 'saving' : 'local');
      setError('');
    }
    setChange(n => n + 1);
  }, [canUseServer, cache]);

  const sync = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !canUseServer || saving.current || conflicted.current || deleting.current) return;
    saving.current = true;
    const sentVersion = version.current;
    setStatus('saving');
    try {
      const response = await fetch('/api/state', {
        method: 'PUT', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: current.current, revision: revision.current, cacheScope }),
      });
      const data = await response.json() as { code?: string; state?: LearningState; revision: number; error?: string };
      if (signal.aborted) return;
      if (response.status === 401 || data.code === 'identity_changed') { recheck(); return; }
      if (response.status === 409 && data.code === 'revision_conflict') {
        remote.current = { state: data.state || {}, revision: data.revision };
        conflicted.current = true;
        setStatus('conflict');
        setError('另一个页面更新了学习记录。两份记录均已保留，请选择要继续的记录。');
        return;
      }
      if (!response.ok) throw new Error(data.error || '服务器保存失败');
      revision.current = data.revision;
      if (sentVersion === version.current) { if (cache(false)) { setStatus('saved'); setError(''); } }
      else { cache(true); setChange(n => n + 1); }
    } catch (cause) {
      if (!signal.aborted && cache(true)) {
        setStatus('local');
        setError(`${cause instanceof Error ? cause.message : '连接中断'}；已保留本机恢复副本。`);
      }
    } finally { saving.current = false; }
  }, [cacheScope, canUseServer, recheck, cache]);

  useEffect(() => {
    if (!ready || !change || conflicted.current) return;
    const timer = setTimeout(() => { void sync(); }, 900);
    return () => clearTimeout(timer);
  }, [change, ready, sync]);

  useEffect(() => {
    const online = () => { if (change && !conflicted.current) void sync(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [change, sync]);

  const resolveConflict = useCallback((useLocal: boolean) => {
    if (!remote.current || !lifetime.current || lifetime.current.signal.aborted) return;
    try { localStorage.setItem(`${CACHE_KEY}:${cacheScope}:conflict-${Date.now()}`, JSON.stringify({ local: current.current, remote: remote.current })); } catch { /* Preserve primary cache. */ }
    revision.current = remote.current.revision;
    conflicted.current = false;
    setError('');
    if (useLocal) { cache(true); setChange(n => n + 1); setStatus('saving'); }
    else { current.current = { ...defaults, ...normalizeLearningState(remote.current.state) }; setState(current.current); if (cache(false)) setStatus('saved'); return current.current; }
  }, [cache, cacheScope]);

  const deleteRecords = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || deleting.current) return false;
    deleting.current = true;
    setStatus('saving');
    try {
      while (saving.current && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 50));
      if (signal.aborted) return false;
      if (canUseServer) {
        const response = await fetch('/api/state', { method: 'DELETE', signal, headers: { 'X-Learning-Scope': cacheScope } });
        if (response.status === 401 || response.status === 409) { recheck(); return false; }
        if (!response.ok) { const payload = await response.json().catch(() => ({})) as { error?: string }; throw new Error(payload.error || '服务器删除失败，请稍后重试'); }
      }
      if (signal.aborted) return false;
      current.current = { ...defaults };
      revision.current = 0;
      version.current++;
      conflicted.current = false;
      setState(current.current);
      setChange(0);
      const key = `${CACHE_KEY}:${cacheScope}`;
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      keys.forEach(item => { if (item && (item === key || item.startsWith(`${key}:conflict-`))) localStorage.removeItem(item); });
      setError('');
      setStatus(canUseServer ? 'saved' : 'local');
      return true;
    } catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : '删除失败，原记录仍保留。');
        setStatus('local');
      }
      return false;
    } finally { deleting.current = false; }
  }, [canUseServer, cacheScope, recheck]);

  return { state, update, ready, status, error, authenticated, canUseServer, guest, cacheScope, sync, resolveConflict, deleteRecords };
}
