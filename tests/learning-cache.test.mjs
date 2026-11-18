import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReaderSession, readReaderSnapshot, saveLearningCache, selectLearningSnapshot } from '../lib/learning-cache.ts';

test('edited code, predictions and reading position survive an anonymous reload', () => {
  const stored = new Map();
  const storage = { setItem: (key, value) => stored.set(key, value) };
  const state = { chapterId: 'upper-01', anchor: 'paragraph::42', codes: { cell: 'answer = 42' }, predictions: { guess: '3' } };
  for (const dirty of [true, false]) {
    assert.equal(saveLearningCache(storage, 'anonymous', { state, dirty, revision: 0, savedAt: 'now' }), true);
    const reloaded = selectLearningSnapshot({ authenticated: false, state: {}, revision: 0 }, JSON.parse(stored.get('anonymous')));
    assert.deepEqual(reloaded.state, state);
    assert.equal(reloaded.mode, 'device');
  }
});

test('a cloud conflict keeps the edited local code instead of overwriting it', () => {
  const snapshot = { authenticated: true, state: { codes: { cell: 'cloud' } }, revision: 8 };
  const draft = { state: { codes: { cell: 'local edit' } }, revision: 7, dirty: true, savedAt: 'now' };
  const result = selectLearningSnapshot(snapshot, draft);
  assert.equal(result.mode, 'conflict');
  assert.equal(result.state.codes.cell, 'local edit');
  assert.equal(result.revision, 7);
  assert.equal(selectLearningSnapshot(snapshot, { ...draft, dirty: false }).state.codes.cell, 'cloud');
});

test('an unsynced draft at the current revision is retained for the next save', () => {
  const result = selectLearningSnapshot({ authenticated: true, state: {}, revision: 4 }, { state: { codes: { cell: 'print(1)' } }, revision: 4, dirty: true, savedAt: 'now' });
  assert.equal(result.mode, 'pending');
  assert.equal(result.state.codes.cell, 'print(1)');
});

test('blocked storage reports failure instead of a false saved state', () => {
  assert.equal(saveLearningCache({ setItem() { throw new Error('QuotaExceededError'); } }, 'key', { state: {}, dirty: true, revision: 0, savedAt: 'now' }), false);
});

const accountA = 'a'.repeat(32), accountB = 'b'.repeat(32);
const snapshot = scope => ({ authenticated: scope !== 'anonymous', cacheScope: scope, revision: 0 });

test('offline startup can only select guest records, even after account hints or an incomplete identity', async () => {
  const shown = [], hints = [];
  let online = false;
  const tracker = createReaderSession(async () => {
    if (!online) throw Error('offline');
    return { authenticated: true, revision: 0 };
  }, s => shown.push(s), h => hints.push(h));
  await tracker.refresh();
  assert.equal(shown.at(-1).scope, 'anonymous');
  assert.equal(shown.at(-1).verified, false);
  online = true;
  tracker.storageChanged(accountA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown.at(-1).scope, 'anonymous');
  assert.deepEqual(hints, []);
});

test('reverification keeps the current notebook for the same identity and removes it before loading a different identity', async () => {
  const shown = [], probes = [];
  let scope = accountA;
  const tracker = createReaderSession(async identityOnly => { probes.push(identityOnly); return snapshot(scope); }, s => shown.push(s?.scope), () => {});
  await tracker.refresh();
  await tracker.refresh();
  assert.deepEqual(shown, [accountA]);
  scope = accountB;
  await tracker.refresh();
  assert.deepEqual(shown, [accountA, undefined, accountB]);
  assert.deepEqual(probes, [false, true, true, false]);
  scope = 'anonymous';
  tracker.storageChanged('anonymous');
  assert.equal(shown.at(-1), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown.at(-1), 'anonymous');
});

test('a late private snapshot cannot replace the session after another tab signs out', async () => {
  const shown = [];
  let scope = accountA, resolveLate, networkCalls = 0;
  const tracker = createReaderSession(async () => {
    if (++networkCalls === 2) return new Promise(resolve => { resolveLate = resolve; });
    return snapshot(scope);
  }, s => shown.push(s?.scope), () => {});
  await tracker.refresh();
  const oldRequest = tracker.refresh();
  scope = 'anonymous';
  tracker.storageChanged('anonymous');
  resolveLate(snapshot(accountA));
  await oldRequest;
  assert.deepEqual(shown, [accountA, undefined, 'anonymous']);
});


const selfHostedAnonymous = { authenticated: false, identityKind: 'anonymous', recognized: false, cacheScope: 'anonymous', revision: 0 };
const guest = scope => ({ authenticated: false, identityKind: 'guest', recognized: true, cacheScope: scope, revision: 3, state: { anchor: 'guest-page' } });

test('guest records use their own revision, restore edits and surface sync conflicts', () => {
  const server = guest(accountB);
  const draft = { revision: 3, dirty: true, state: { codes: { cell: 'mine' } }, savedAt: 'now' };
  assert.deepEqual(selectLearningSnapshot(server, null), { state: server.state, revision: 3, mode: 'cloud' });
  assert.equal(selectLearningSnapshot(server, draft).mode, 'pending');
  assert.equal(selectLearningSnapshot(server, { ...draft, revision: 2 }).mode, 'conflict');
});

test('malformed guest scopes and unrecognized private responses cannot open cached records', async () => {
  const rejected = [
    { ...guest(accountA), recognized: false },
    { ...guest(accountA), cacheScope: 'anonymous' },
    { ...guest(accountA), cacheScope: 'not-a-scope' },
    { ...guest(accountA), authenticated: true },
    { ...selfHostedAnonymous, cacheScope: accountA },
  ];
  for (const response of rejected) {
    let shown;
    const tracker = createReaderSession(async () => response, session => { shown = session; }, () => {});
    await tracker.refresh();
    assert.equal(shown.scope, 'anonymous');
    assert.equal(shown.verified, false);
    assert.equal(shown.snapshot.state, undefined);
  }
});

test('only the credentialed confirmation opens a new guest, including concurrent first visits', async () => {
  let cookie = false, queued = Promise.resolve();
  const calls = [];
  const locks = { request(name, {signal}, work) {
    assert.equal(name, 'ai-book-reader-bootstrap');
    signal.throwIfAborted();
    const next = queued.then(work);
    queued = next.catch(() => {});
    return next;
  }};
  const request = async (url, options) => {
    assert.equal(url, '/api/state');
    assert.equal(options.credentials, 'same-origin');
    const bootstrap = !!options.headers?.['X-Book-Visitor-Bootstrap'];
    calls.push(bootstrap);
    if (!cookie) {
      assert.equal(bootstrap, true);
      await new Promise(resolve => setImmediate(resolve));
      cookie = true;
      return Response.json(selfHostedAnonymous, { headers: { 'X-Book-Guest-Bootstrap': '1' } });
    }
    return Response.json(guest(accountB));
  };
  const read = () => readReaderSnapshot(false, new AbortController().signal, { locks }, request);
  const result = await Promise.all([read(), read()]);
  assert.deepEqual(calls, [true, false, true]);
  assert.deepEqual(result, [guest(accountB), guest(accountB)]);
});

test('blocked cookies get one read-only retry then local reading, hosted readers get just one request', async () => {
  for (const issued of [true, false]) {
    const calls = [];
    const request = async (_, options) => {
      const bootstrap = !!options.headers?.['X-Book-Visitor-Bootstrap'];
      calls.push(bootstrap);
      return Response.json(issued ? selfHostedAnonymous : snapshot('anonymous'), {
        headers: issued && bootstrap ? { 'X-Book-Guest-Bootstrap': '1' } : {},
      });
    };
    const tracker = createReaderSession((identityOnly, signal) => readReaderSnapshot(identityOnly, signal, undefined, request),
      session => { assert.equal(session.scope, 'anonymous'); assert.equal(!!session.snapshot.guestCookieBlocked, issued); }, () => {});
    await tracker.refresh();
    await tracker.refresh(); // ordinary focus poll is read-only, even if cookies are disabled
    assert.deepEqual(calls, issued ? [true, false, false] : [true, false]);
  }
});

test('a denied lock getter or acquisition still confirms accepted or blocked cookies exactly once', async () => {
  for (const name of ['SecurityError', 'NotAllowedError']) {
    const denied = () => { throw new DOMException('Site storage disabled', name); };
    for (const browser of [{ get locks() { return denied(); } }, { locks: { request: async () => denied() } }]) {
      for (const acceptsCookie of [true, false]) {
        const calls = [];
        const request = async (_, options) => {
          const bootstrap = !!options.headers?.['X-Book-Visitor-Bootstrap'];
          calls.push(bootstrap);
          return bootstrap
            ? Response.json(selfHostedAnonymous, { headers: { 'X-Book-Guest-Bootstrap': '1' } })
            : Response.json(acceptsCookie ? guest(accountA) : selfHostedAnonymous);
        };
        const result = await readReaderSnapshot(false, new AbortController().signal, browser, request);
        assert.deepEqual(calls, [true, false]);
        assert.equal(result.cacheScope, acceptsCookie ? accountA : 'anonymous');
        assert.equal(!!result.guestCookieBlocked, !acceptsCookie);
      }
    }
  }
});

test('lock fallback never repeats a started request or a cancelled or unrelated lock failure', async () => {
  const controller = new AbortController();
  const denied = new DOMException('Denied', 'SecurityError');
  let calls = 0;
  const failingRequest = async () => { calls++; throw denied; };
  const entered = { locks: { request: (_, __, callback) => callback() } };
  await assert.rejects(readReaderSnapshot(false, controller.signal, entered, failingRequest), error => error === denied);
  assert.equal(calls, 1);
  for (const failure of [new Error('Unexpected failure'), denied]) {
    if (failure === denied) controller.abort();
    const lockFailure = { locks: { request: async () => { throw failure; } } };
    await assert.rejects(readReaderSnapshot(false, controller.signal, lockFailure, failingRequest), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('cleared cookies release the guest before another guest or account is shown', async () => {
  const shown = [];
  let full = guest(accountA), probe = selfHostedAnonymous;
  const tracker = createReaderSession(async identityOnly => identityOnly ? probe : full, s => shown.push(s?.scope), () => {});
  await tracker.refresh();
  full = guest(accountB);
  await tracker.refresh();
  full = probe = { ...snapshot(accountA), identityKind: 'account', recognized: true };
  await tracker.refresh();
  assert.deepEqual(shown, [accountA, undefined, accountB, undefined, accountA]);
});
