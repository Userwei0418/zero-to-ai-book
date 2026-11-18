import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveLearningCache, selectLearningSnapshot } from '../lib/learning-cache.ts';

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
