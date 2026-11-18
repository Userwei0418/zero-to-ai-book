import type { LearningState } from './course-types';

export type LearningCache = { state: LearningState; revision: number; dirty: boolean; savedAt: string };
export type LearningSnapshot = {
  state?: LearningState;
  revision: number;
  authenticated?: boolean;
  cacheScope?: string;
  identityKind?: 'account' | 'guest' | 'anonymous';
  recognized?: boolean;
  guestCookieBlocked?: boolean;
};

function isGuest(snapshot: LearningSnapshot) {
  return snapshot.authenticated === false && snapshot.identityKind === 'guest'
    && snapshot.recognized === true && /^[0-9a-f]{32}$/.test(snapshot.cacheScope || '');
}

export function hasServerRecords(snapshot: LearningSnapshot) {
  return snapshot.authenticated === true || isGuest(snapshot);
}

/** An anonymous response has no server records and must never erase a local draft. */
export function selectLearningSnapshot(snapshot: LearningSnapshot, local: LearningCache | null) {
  if (!hasServerRecords(snapshot)) return {
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
  if (snapshot.authenticated === false && snapshot.cacheScope === 'anonymous' && (!snapshot.identityKind || snapshot.identityKind === 'anonymous') && !snapshot.recognized) return 'anonymous';
  if (isGuest(snapshot)) return snapshot.cacheScope!;
  if (snapshot.authenticated === true && snapshot.recognized !== false
      && (!snapshot.identityKind || snapshot.identityKind === 'account')
      && /^[0-9a-f]{32}$/.test(snapshot.cacheScope || '')) return snapshot.cacheScope!;
  throw new Error('无法确认当前读者');
}

/** Mint only during a full load. The second request proves the browser accepted the cookie. */
export async function readReaderSnapshot(
  identityOnly: boolean, signal: AbortSignal, locks?: Pick<LockManager, 'request'>, request = fetch,
): Promise<LearningSnapshot> {
  const url = identityOnly ? '/api/state?identity=1' : '/api/state';
  async function get(bootstrap: boolean) {
    const response = await request(url, {
      credentials: 'same-origin', cache: 'no-store', signal,
      headers: bootstrap ? { 'X-Book-Visitor-Bootstrap': '1' } : undefined,
    });
    if (!response.ok) throw new Error('暂时无法读取学习记录');
    const snapshot = await response.json() as LearningSnapshot;
    return { snapshot, issued: response.headers.get('X-Book-Guest-Bootstrap') === '1' };
  }
  if (identityOnly) return (await get(false)).snapshot;
  async function load() {
    const first = await get(true);
    if (!first.issued) return first.snapshot;
    const { snapshot } = await get(false);
    return scopeFor(snapshot) === 'anonymous' ? { ...snapshot, guestCookieBlocked: true } : snapshot;
  }
  // A pair of brand-new tabs must finish the cookie round trip before either can mint again.
  return locks ? locks.request('ai-book-reader-bootstrap', { signal }, load) : load();
}

/** A scope hint may invalidate a session. Only a server response may open private records. */
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
