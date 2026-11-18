import type { LearningState } from './course-types';

export type LearningCache = { state: LearningState; revision: number; dirty: boolean; savedAt: string };
export type LearningSnapshot = { state?: LearningState; revision: number; authenticated?: boolean; cacheScope?: string };

/** An anonymous response has no server records and must never erase a local draft. */
export function selectLearningSnapshot(snapshot: LearningSnapshot, local: LearningCache | null) {
  if (!snapshot.authenticated) return {
    state: local?.state || {}, revision: 0, mode: 'device' as const,
  };
  if (local?.dirty) return {
    state: local.state, revision: local.revision || 0,
    mode: local.revision !== snapshot.revision ? 'conflict' as const : 'pending' as const,
  };
  return { state: snapshot.state || {}, revision: snapshot.revision || 0, mode: 'cloud' as const };
}

export function saveLearningCache(storage: Pick<Storage, 'setItem'>, key: string, value: LearningCache) {
  try { storage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export const READER_SCOPE_HINT = 'ai-book-learning-v1:active-scope';
export type ReaderSession = { scope: string; snapshot: LearningSnapshot; verified: boolean };

function scopeFor(snapshot: LearningSnapshot) {
  if (snapshot.authenticated === false && snapshot.cacheScope === 'anonymous') return 'anonymous';
  if (snapshot.authenticated === true && /^[0-9a-f]{32}$/.test(snapshot.cacheScope || '')) return snapshot.cacheScope!;
  throw new Error('无法确认当前阅读账号');
}

/** A scope hint from another tab may invalidate a session. Only the server may open an account. */
export function createReaderSession(
  read: (identityOnly: boolean, signal: AbortSignal) => Promise<LearningSnapshot>,
  show: (session: ReaderSession | null) => void,
  verified: (scope: string) => void,
) {
  let session: ReaderSession | null = null;
  let pending: AbortController | null = null;
  function activate(next: ReaderSession | null) { session = next; show(next); }

  async function refresh(invalidate = false) {
    if (invalidate) {
      pending?.abort();
      if (session) activate(null);
    } else if (pending) return;
    const request = new AbortController();
    pending = request;
    try {
      if (session?.verified) {
        const identity = await read(true, request.signal);
        if (request.signal.aborted) return;
        if (scopeFor(identity) === session.scope) return;
        activate(null);
      }
      const snapshot = await read(false, request.signal);
      if (request.signal.aborted) return;
      const scope = scopeFor(snapshot);
      activate({ scope, snapshot, verified: true });
      verified(scope);
    } catch {
      if (!request.signal.aborted && !session) activate({
        scope: 'anonymous', verified: false,
        snapshot: { authenticated: false, cacheScope: 'anonymous', revision: 0 },
      });
    } finally {
      if (pending === request) pending = null;
    }
  }

  return {
    refresh,
    storageChanged(hint: string | null) {
      if (hint !== session?.scope || !session?.verified) void refresh(true);
    },
    dispose() { pending?.abort(); },
  };
}
