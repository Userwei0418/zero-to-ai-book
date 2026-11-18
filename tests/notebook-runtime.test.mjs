/**
 * Runtime contract tests; no network requests or paid execution services.
 * Run with Node >= 22.13: node --test tests/notebook-runtime.test.mjs
 * Real Python/WASM behavior is covered separately by notebook-worker-real.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookKernel, getNotebookKernel, clearNotebookHistory, releaseNotebookSessions } from '../lib/notebook-runtime.ts';

const cell = (id, runtime = 'browser') => ({
  block: { id, type: 'code', language: 'python', runtime, runnable: true, code: 'value = 2' },
  value: 'value = 42\nprint(value)',
});

test('Notebook runtime account and remote-execution contracts', async (suite) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return stored.size; },
      key: (index) => [...stored.keys()][index] ?? null,
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(String(key), String(value)),
      removeItem: (key) => stored.delete(key),
    },
  });
  suite.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
  });

  await suite.test('live kernels are partitioned by account scope and chapter', () => {
    const first = getNotebookKernel('chapter-memory', 'learner-a');
    assert.equal(getNotebookKernel('chapter-memory', 'learner-a'), first);
    assert.notEqual(getNotebookKernel('chapter-memory', 'learner-b'), first);
    assert.notEqual(getNotebookKernel('chapter-other', 'learner-a'), first);
    assert.notEqual(getNotebookKernel('chapter-default'), getNotebookKernel('chapter-default'));
    assert.notEqual(getNotebookKernel('chapter-pending', 'pending'), getNotebookKernel('chapter-pending', 'pending'));
    assert.notEqual(getNotebookKernel('chapter-memory'), first);
  });

  await suite.test('switching readers releases a running kernel and preserves its own historical output', async (t) => {
    const chapter = 'account-switch';
    const first = getNotebookKernel(chapter, 'learner-a');
    const other = getNotebookKernel(chapter, 'learner-b');
    const sample = cell('private', 'linux');
    let reply, sentSignal;
    first.setRemoteConfigured(true);
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (JSON.parse(options.body).action === 'interrupt') return Response.json({ status: 'ok' });
      sentSignal = options.signal;
      return new Promise(resolve => { reply = resolve; });
    });
    const execution = first.execute(sample);
    releaseNotebookSessions('learner-a');
    assert.equal(sentSignal.aborted, true);
    reply(Response.json({ status: 'ok', stdout: 'late output', stderr: '' }));
    assert.equal((await execution).status, 'interrupted');
    assert.equal(await first.execute(sample), undefined);
    const resumed = getNotebookKernel(chapter, 'learner-a');
    assert.notEqual(resumed, first);
    resumed.hydrate();
    assert.equal(resumed.getSnapshot().results.private.historical, true);
    assert.doesNotMatch(resumed.getSnapshot().results.private.stdout, /late output/);
    assert.equal(getNotebookKernel(chapter, 'learner-b'), other);
    other.hydrate();
    assert.deepEqual(other.getSnapshot().results, {});
  });

  await suite.test('a stale guest scope in a run or reset requests identity verification', async (t) => {
    const scope = 'b'.repeat(32);
    const kernel = new NotebookKernel('guest-switch', scope);
    const sample = cell('guest-cell', 'linux');
    kernel.setRemoteConfigured(true);
    let rechecks = 0;
    kernel.setIdentityChangeHandler(() => { rechecks++; });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(JSON.parse(options.body).cacheScope, scope);
      return Response.json({ code: 'identity_changed', error: '读者已变化' }, { status: 409 });
    });
    assert.equal((await kernel.execute(sample)).status, 'error');
    assert.equal(rechecks, 1);
    assert.equal(await kernel.reset(), false);
    assert.equal(rechecks, 2);
  });

  await suite.test('saved output hydrates only into its own account scope', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'ok', stdout: 'learner-a private output\n', stderr: '', executionCount: 3, elapsedMs: 12,
    }));
    const first = new NotebookKernel('chapter-cache', 'learner-a');
    const sample = cell('cached-cell', 'linux');
    first.setRemoteConfigured(true);
    first.registerAll([sample]);
    const result = await first.execute(sample);
    assert.equal(result.status, 'ok');
    t.mock.timers.tick(600);
    assert.ok(stored.size > 0, 'completed output was persisted');

    const sameAccount = new NotebookKernel('chapter-cache', 'learner-a');
    sameAccount.hydrate();
    const restored = sameAccount.getSnapshot().results['cached-cell'];
    assert.equal(restored.stdout, 'learner-a private output\n');
    assert.equal(restored.historical, true);

    const otherAccount = new NotebookKernel('chapter-cache', 'learner-b');
    otherAccount.hydrate();
    assert.equal(otherAccount.getSnapshot().results['cached-cell'], undefined);
    const anonymous = new NotebookKernel('chapter-cache');
    anonymous.hydrate();
    assert.equal(anonymous.getSnapshot().results['cached-cell'], undefined);
    const pending = new NotebookKernel('chapter-cache', 'pending');
    pending.hydrate();
    assert.equal(pending.getSnapshot().results['cached-cell'], undefined);
    t.mock.timers.tick(600);
    const storageBefore = new Map(stored);
    anonymous.setRemoteConfigured(true);
    await anonymous.execute(sample);
    pending.setRemoteConfigured(true);
    await pending.execute(sample);
    t.mock.timers.tick(600);
    assert.deepEqual(stored, storageBefore, 'unresolved identities never persist output');
  });

  await suite.test('a configured mixed chapter shares the Linux runtime and preserves GPU selection', () => {
    const kernel = new NotebookKernel('chapter-routing', 'learner-a');
    const cells = [cell('plain'), cell('linux', 'linux'), cell('api', 'api'), cell('gpu', 'gpu')];
    kernel.registerAll(cells);
    kernel.setRemoteConfigured(true);
    assert.equal(kernel.runtimeFor(cells[0].block), 'linux');
    assert.equal(kernel.runtimeFor(cells[1].block), 'linux');
    assert.equal(kernel.runtimeFor(cells[2].block), 'linux');
    assert.equal(kernel.runtimeFor(cells[3].block), 'gpu');
    kernel.setRemoteConfigured(false);
    assert.equal(kernel.runtimeFor(cells[0].block), 'browser');
  });

  await suite.test('legacy scoped history migrates without reading another account or unscoped outputs', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const record = { old: { code: 'print(42)', status: 'ok', stdout: '42\n', stderr: '', images: [] } };
    const legacyKey = 'ai-book-results-v1:legacy-account:legacy-chapter';
    localStorage.setItem(legacyKey, JSON.stringify(record));
    localStorage.setItem('ai-book-results-v1:legacy-chapter', JSON.stringify(record));
    const wrongAccount = new NotebookKernel('legacy-chapter', 'another-account'); wrongAccount.hydrate();
    assert.deepEqual(wrongAccount.getSnapshot().results, {});
    const kernel = new NotebookKernel('legacy-chapter', 'legacy-account'); kernel.hydrate();
    assert.equal(kernel.getSnapshot().results.old.stdout, '42\n');
    t.mock.timers.tick(600);
    assert.equal(localStorage.getItem(legacyKey), null);
    assert.ok(localStorage.getItem('ai-book-results-v2:legacy-account:legacy-chapter'));
    localStorage.setItem(legacyKey, JSON.stringify(record));
    clearNotebookHistory('legacy-account');
    assert.equal(localStorage.getItem(legacyKey), null);
    assert.equal(localStorage.getItem('ai-book-results-v2:legacy-account:legacy-chapter'), null);
    assert.ok(localStorage.getItem('ai-book-results-v1:legacy-chapter'), 'unscoped data is never assumed to belong to this account');
  });

  await suite.test('browser-tagged cells in a configured mixed chapter call the Linux gateway', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ status: 'ok', stdout: '42\n', stderr: '', executionCount: 7, elapsedMs: 8 });
    });
    const kernel = new NotebookKernel('chapter-unified', 'learner-a');
    const plain = cell('plain');
    kernel.registerAll([plain, cell('linux', 'linux'), cell('api', 'api')]);
    kernel.setRemoteConfigured(true);
    const result = await kernel.execute(plain);
    assert.equal(result.status, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/runtime');
    assert.equal(requests[0].body.action, 'execute');
    assert.equal(requests[0].body.runtime, 'linux');
    assert.equal(requests[0].body.chapterId, 'chapter-unified');
    assert.equal(requests[0].body.cellId, 'plain');
    assert.equal(requests[0].body.code, plain.value);
    assert.equal(kernel.getSnapshot().count, 7);
    assert.equal(result.executionCount, 7);
  });

  await suite.test('remote PNG objects and strings normalize while invalid and oversized images are discarded', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'ok', stdout: '', stderr: '', executionCount: 11, elapsedMs: 10,
      images: [
        { mimeType: 'image/png', data: 'aGVsbG8=' },
        'data:image/png;base64,d29ybGQ=',
        'cHl0aG9u',
        { mimeType: 'image/jpeg', data: 'aW52YWxpZA==' },
        { mimeType: 'image/png', data: '!broken' },
        'data:image/svg+xml;base64,PHN2Zz4=',
        '<img src=x>', null, {}, 123,
        { mimeType: 'image/png', data: 'A'.repeat(2800001) },
        'A'.repeat(2800001),
        'eA==',
        'eQ==',
      ],
    }));
    const kernel = new NotebookKernel('chapter-images', 'learner-a');
    const sample = cell('plot', 'linux');
    kernel.setRemoteConfigured(true);
    const result = await kernel.execute(sample);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.images, [
      'data:image/png;base64,aGVsbG8=',
      'data:image/png;base64,d29ybGQ=',
      'data:image/png;base64,cHl0aG9u',
      'data:image/png;base64,eA==',
    ]);
    assert.equal(kernel.getSnapshot().count, 11);
  });

  await suite.test('known offline services preserve live state and never start an impossible batch or single cell', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const send = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', stdout: '42', executionCount: 1 }));
    const kernel = new NotebookKernel('capabilities', 'learner-a');
    const local = cell('plain'), remote = cell('cloud', 'api'), gpu = cell('training', 'gpu');
    kernel.registerAll([local, remote, gpu]);
    kernel.setRemoteConfigured(true, false);
    await kernel.execute(remote);
    const liveResult = kernel.getSnapshot().results.cloud;
    kernel.setRemoteConfigured(false, false);
    assert.match(kernel.unavailableReason(remote.block), /API 实验/);
    assert.match(kernel.unavailableReason(gpu.block), /GPU/);
    assert.equal(kernel.unavailableReason(local.block), undefined);
    await kernel.runAll();
    await kernel.runBefore('training');
    assert.equal(await kernel.execute(remote), undefined);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(kernel.getSnapshot().results.cloud, liveResult);
    assert.equal(kernel.getSnapshot().count, 1);
    assert.equal(kernel.getSnapshot().batch, false);
    assert.equal(kernel.getSnapshot().results.training, undefined);
    kernel.setRemoteConfigured(false, true);
    assert.equal(kernel.unavailableReason(gpu.block), undefined);
  });

  await suite.test('an unavailable remote service returns a real error without fabricated stdout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'unavailable', error: '未配置真实远程运行环境。',
    }, { status: 503 }));
    const kernel = new NotebookKernel('chapter-unavailable', 'learner-a');
    kernel.setRemoteConfigured(true);
    const result = await kernel.execute(cell('offline', 'linux'));
    assert.equal(result.status, 'error');
    assert.equal(result.stdout, '');
    assert.equal(result.executionCount, undefined);
    assert.match(result.error, /未配置真实远程/);
    assert.equal(kernel.getSnapshot().phase, 'error');
    assert.equal(kernel.getSnapshot().count, 0);
  });

  await suite.test('structured tables survive scoped history and large images are explicitly marked as omitted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const table = { columns: ['课程', '得分'], rows: [['<script>只是文本</script>', '42']] };
    t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', stdout: '', stderr: '', executionCount: 1,
      tables: [table, { columns: ['bad'], rows: [[{ html: '<script>' }]] }, { columns: ['bad'], rows: [['a', 'b']] }],
      images: ['aGVsbG8='],
    }));
    const kernel = new NotebookKernel('chapter-table-history', 'learner-a');
    kernel.setRemoteConfigured(true);
    const result = await kernel.execute(cell('table-cell', 'linux'));
    assert.deepEqual(result.tables, [table]);
    t.mock.timers.tick(600);
    const fresh = new NotebookKernel('chapter-table-history', 'learner-a');
    fresh.hydrate();
    const restored = fresh.getSnapshot().results['table-cell'];
    assert.deepEqual(restored.tables, [table]);
    assert.deepEqual(restored.images, []);
    assert.equal(restored.mediaOmitted, true);
    assert.equal(restored.historical, true);
    assert.match(fresh.getSnapshot().message, /按顺序重新执行/);
  });

  await suite.test('runBefore rebuilds only runnable predecessors in chapter order and exposes progress', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return Response.json({ status: 'ok', stdout: request.code || '', stderr: '', executionCount: requests.length });
    });
    const kernel = new NotebookKernel('chapter-before', 'learner-a');
    const first = cell('first', 'linux'), output = cell('output', 'linux'), command = cell('command', 'linux');
    output.block.runnable = false; command.block.language = 'bash';
    const second = cell('second', 'linux'), target = cell('target', 'linux'), after = cell('after', 'linux');
    kernel.registerAll([first, output, command, second, target, after]);
    kernel.setRemoteConfigured(true);
    const progress = [];
    kernel.subscribe(() => { const p = kernel.getSnapshot().batchProgress; if (p) progress.push(p.completed); });
    await kernel.runBefore('target');
    assert.equal(requests[0].action, 'reset');
    assert.deepEqual(requests.filter(request => request.action === 'execute').map(request => request.cellId), ['first', 'second']);
    assert.deepEqual(kernel.getSnapshot().batchProgress, { completed: 2, total: 2, targetCell: 'target' });
    assert.ok(progress.includes(0) && progress.includes(1) && progress.includes(2));
    assert.equal(kernel.getSnapshot().batch, false);
    assert.match(kernel.getSnapshot().message, /现在可以运行当前单元/);
  });

  await suite.test('runBefore does not reset an unrelated later GPU runtime', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return Response.json(request.runtime === 'gpu' ? { status: 'unavailable' } : { status: 'ok', stdout: '', stderr: '' }, { status: request.runtime === 'gpu' ? 503 : 200 });
    });
    const kernel = new NotebookKernel('chapter-before-gpu', 'learner-a');
    kernel.registerAll([cell('first', 'linux'), cell('target', 'linux'), cell('later', 'gpu')]);
    kernel.setRemoteConfigured(true);
    await kernel.runBefore('target');
    assert.deepEqual(requests.map(request => [request.action, request.runtime]), [['reset', 'linux'], ['execute', 'linux']]);
    assert.match(kernel.getSnapshot().message, /现在可以运行当前单元/);
  });

  await suite.test('editing another source file invalidates old dependent output until it is rerun', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ status: 'ok', stdout: '2/6\n', stderr: '' });
    });
    const kernel = new NotebookKernel('chapter-dependency', 'learner-a');
    kernel.setRemoteConfigured(true);
    const router = cell('router', 'linux'); router.block.filename = 'router.py'; router.block.code = router.value;
    const exam = cell('exam', 'linux');
    kernel.setFiles({ 'router.py': router.value }); kernel.registerAll([router, exam]);
    await kernel.execute(exam);
    kernel.setFiles({ 'router.py': router.value });
    assert.equal(kernel.getSnapshot().results.exam.inputsChanged, undefined, 'same contents do not invalidate');
    kernel.register({ ...router, value: 'value = 99\nprint(value)' });
    assert.equal(kernel.getSnapshot().results.exam.inputsChanged, true);
    await kernel.execute(exam);
    assert.equal(requests.at(-1).files['router.py'], 'value = 99\nprint(value)', 'edited complete module is passed to the runtime');
    assert.equal(kernel.getSnapshot().results.exam.inputsChanged, undefined);
    kernel.setFiles({ 'router.py': router.value, 'exam-data.json': '[1,2]' });
    assert.equal(kernel.getSnapshot().results.exam.inputsChanged, true);
  });

  await suite.test('ordered restoration stops on the first actual failure without claiming later cells ran', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const executed = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.action === 'reset') return Response.json({ status: 'ok' });
      executed.push(request.cellId);
      return Response.json({ status: request.cellId === 'second' ? 'error' : 'ok', stdout: '', stderr: '', error: request.cellId === 'second' ? 'NameError: missing' : undefined });
    });
    const kernel = new NotebookKernel('chapter-sequence-failure', 'learner-a');
    kernel.registerAll(['first', 'second', 'third'].map(id => cell(id, 'linux')));
    kernel.setRemoteConfigured(true);
    await kernel.runAll();
    assert.deepEqual(executed, ['first', 'second']);
    assert.equal(kernel.getSnapshot().results.third, undefined);
    assert.match(kernel.getSnapshot().results.second.error, /NameError/);
    assert.equal(kernel.getSnapshot().batchProgress.completed, 1);
    assert.equal(kernel.getSnapshot().batch, false);
  });

  await suite.test('stopping while runAll awaits reset prevents every later execution', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    let releaseReset;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.action === 'reset') return new Promise((resolve) => { releaseReset = resolve; });
      return Response.json({ status: 'ok', stdout: 'previous output\n', stderr: '', executionCount: 1 });
    });
    const kernel = new NotebookKernel('chapter-cancel-batch', 'learner-a');
    kernel.setRemoteConfigured(true);
    const sample = cell('cancelled-batch', 'linux');
    kernel.registerAll([sample]);
    await kernel.execute(sample);
    requests.length = 0;
    const runningAll = kernel.runAll();
    assert.equal(kernel.getSnapshot().batch, true);
    assert.equal(typeof releaseReset, 'function');
    kernel.stop();
    releaseReset(Response.json({ status: 'ok' }));
    await runningAll;
    assert.equal(kernel.getSnapshot().batch, false);
    assert.equal(requests.filter((request) => request.action === 'execute').length, 0);
    assert.ok(requests.every((request) => request.chapterId === 'chapter-cancel-batch'));
    const historical = kernel.getSnapshot().results['cancelled-batch'];
    assert.equal(historical.historical, true);
    assert.equal(historical.stdout, 'previous output\n');
  });

  await suite.test('runAll does not execute cells after an unsuccessful remote reset', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.action === 'reset') return Response.json({ status: 'unavailable' }, { status: 503 });
      return Response.json({ status: 'ok', stdout: 'initial\n', stderr: '', executionCount: 1 });
    });
    const kernel = new NotebookKernel('chapter-reset-failure', 'learner-a');
    const sample = cell('reset-failure', 'linux');
    kernel.setRemoteConfigured(true);
    kernel.registerAll([cell('earlier-browser'), sample]);
    await kernel.execute(sample);
    requests.length = 0;
    await kernel.runAll();
    assert.equal(requests.filter((request) => request.action === 'execute').length, 0);
    assert.equal(kernel.getSnapshot().batch, false);
    assert.match(kernel.getSnapshot().message, /远程重置未成功/);
  });

  await suite.test('clearing one account clears only its live results and stored outputs', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'ok', stdout: 'retained output\n', stderr: '', executionCount: 1,
    }));
    const first = getNotebookKernel('chapter-clear', 'clear-account-a');
    const other = getNotebookKernel('chapter-clear', 'clear-account-b');
    const cold = new NotebookKernel('chapter-cold', 'clear-account-a');
    const similarScope = new NotebookKernel('chapter-clear', 'clear-account-a-extra');
    const sample = cell('clear-cell', 'linux');
    for (const kernel of [first, other, cold, similarScope]) { kernel.setRemoteConfigured(true); await kernel.execute(sample); }
    t.mock.timers.tick(600);
    localStorage.setItem('unrelated-learning-state', 'keep me');
    clearNotebookHistory('clear-account-a');
    t.mock.timers.tick(600);
    assert.deepEqual(first.getSnapshot().results, {});
    assert.equal(getNotebookKernel('chapter-clear', 'clear-account-a'), first, 'mounted consumers keep the same cleared kernel');
    assert.equal(getNotebookKernel('chapter-clear', 'clear-account-b'), other);
    assert.equal(other.getSnapshot().results['clear-cell'].stdout, 'retained output\n');
    const clearedCold = new NotebookKernel('chapter-cold', 'clear-account-a');
    clearedCold.hydrate();
    assert.equal(clearedCold.getSnapshot().results['clear-cell'], undefined);
    const keptOther = new NotebookKernel('chapter-clear', 'clear-account-b');
    keptOther.hydrate();
    assert.equal(keptOther.getSnapshot().results['clear-cell'].stdout, 'retained output\n');
    const keptSimilarScope = new NotebookKernel('chapter-clear', 'clear-account-a-extra');
    keptSimilarScope.hydrate();
    assert.equal(keptSimilarScope.getSnapshot().results['clear-cell'].stdout, 'retained output\n');
    assert.equal(localStorage.getItem('unrelated-learning-state'), 'keep me');
  });

  await suite.test('the three-kernel LRU releases the least recent chapter and preserves its history', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'ok', stdout: 'LRU output\n', stderr: '', executionCount: 1,
    }));
    const first = getNotebookKernel('lru-first', 'lru-account');
    const second = getNotebookKernel('lru-second', 'lru-account');
    const third = getNotebookKernel('lru-third', 'lru-account');
    const sample = cell('lru-cell', 'linux');
    for (const kernel of [first, second, third]) { kernel.setRemoteConfigured(true); await kernel.execute(sample); }
    assert.equal(getNotebookKernel('lru-first', 'lru-account'), first);
    getNotebookKernel('lru-fourth', 'lru-account');
    assert.match(second.getSnapshot().message, /回收/);
    assert.equal(second.getSnapshot().results['lru-cell'].historical, true);
    assert.equal(second.getSnapshot().count, 0);
    assert.equal(getNotebookKernel('lru-first', 'lru-account'), first);
    assert.equal(getNotebookKernel('lru-third', 'lru-account'), third);
    const restored = getNotebookKernel('lru-second', 'lru-account');
    assert.notEqual(restored, second);
    restored.hydrate();
    assert.equal(restored.getSnapshot().results['lru-cell'].stdout, 'LRU output\n');
    assert.equal(restored.getSnapshot().results['lru-cell'].historical, true);
  });

  await suite.test('blocked storage leaves execution working and exposes a recoverable save error', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      status: 'ok', stdout: 'still executed\n', stderr: '', executionCount: 1,
    }));
    const failingWrite = t.mock.method(localStorage, 'setItem', () => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });
    const kernel = new NotebookKernel('chapter-storage-error', 'storage-account');
    kernel.setRemoteConfigured(true);
    const sample = cell('storage-cell', 'linux');
    const result = await kernel.execute(sample);
    t.mock.timers.tick(600);
    assert.equal(result.status, 'ok');
    assert.equal(kernel.getSnapshot().results['storage-cell'].stdout, 'still executed\n');
    assert.match(kernel.getSnapshot().persistenceError, /空间不足|禁止存储/);
    failingWrite.mock.restore();
    await kernel.execute(sample);
    t.mock.timers.tick(600);
    assert.equal(kernel.getSnapshot().persistenceError, undefined);
  });
});
