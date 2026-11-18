'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createReaderSession, readReaderSnapshot, READER_SCOPE_HINT, type ReaderSession } from '@/lib/learning-cache';

/** Remount the entire reader when identity changes, including its open drawers and code editors. */
export function useReaderSession() {
  const [session, setSession] = useState<ReaderSession | null>(null);
  const check = useRef<ReturnType<typeof createReaderSession> | null>(null);
  const recheck = useCallback(() => { void check.current?.refresh(true); }, []);
  useEffect(() => {
    let lastScope: string | undefined;
    const monitor = createReaderSession((identityOnly, signal) =>
      readReaderSnapshot(identityOnly, AbortSignal.any([signal, AbortSignal.timeout(10000)]), navigator), next => {
      if (next) {
        if (lastScope && lastScope !== next.scope) {
          const url = new URL(window.location.href);
          if (url.searchParams.has('chapter')) {
            url.searchParams.delete('chapter'); url.hash = '';
            window.history.replaceState(window.history.state, '', url);
          }
        }
        lastScope = next.scope;
      }
      setSession(next);
    }, scope => {
      try { localStorage.setItem(READER_SCOPE_HINT, scope); } catch { /* Browsers can block storage. */ }
    });
    check.current = monitor;
    const visible = () => { if (document.visibilityState === 'visible') void monitor.refresh(); };
    const storage = (event: StorageEvent) => {
      if (event.key === READER_SCOPE_HINT || event.key === null) monitor.storageChanged(event.newValue);
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) void monitor.refresh(true); };
    void monitor.refresh();
    const timer = window.setInterval(visible, 60000);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visible);
    return () => {
      monitor.dispose(); check.current = null;
      window.clearInterval(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return { session, recheck };
}
