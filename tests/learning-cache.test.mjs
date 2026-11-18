import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReaderSession, saveLearningCache, selectLearningSnapshot } from '../lib/learning-cache.ts';

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
