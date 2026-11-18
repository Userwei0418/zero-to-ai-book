/**
 * Executes the production worker with real Pyodide 0.27.7 / CPython 3.12 WASM.
 * No Python execution or output is mocked. Only the browser script loader is
 * replaced with Node's loader and an offline asset directory.
 *
 * Run:
 * NOTEBOOK_PYODIDE_DIR=/tmp/notebook-pyodide-test node --test tests/notebook-worker-real.test.mjs
 *
 * Download these unchanged files from
 * https://cdn.jsdelivr.net/pyodide/v0.27.7/full/ into that directory:
 * pyodide.js, pyodide.asm.js, pyodide.asm.wasm, python_stdlib.zip,
 * pyodide-lock.json. The optional matplotlib test also needs the wheel files
 * for matplotlib and its recursive dependencies from that same lockfile.
 * Dependency wheel hashes are verified by Pyodide. Large assets stay outside
 * the repository. Without NOTEBOOK_PYODIDE_DIR this suite explicitly skips.
 * This test does not verify the browser iframe/CSP boundary; browser QA must.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

const assetDirectory = process.env.NOTEBOOK_PYODIDE_DIR;

test('production Notebook worker executes real Pyodide 0.27.7', {
  skip: !assetDirectory && 'Set NOTEBOOK_PYODIDE_DIR to the fixed-version runtime asset directory.',
  timeout: 90000,
}, async (suite) => {
  const root = path.resolve(assetDirectory) + path.sep;
  const require = createRequire(import.meta.url);
  const actualPyodide = require(root + 'pyodide.js');
  const messages = [];
  let runtime;
  let sequence = 0;
  globalThis.self = globalThis;
  globalThis.postMessage = (message) => messages.push(message);
  globalThis.importScripts = (url) => {
    assert.equal(url, 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
    globalThis.loadPyodide = async (options) => {
      runtime = await actualPyodide.loadPyodide({ ...options, indexURL: root });
      return runtime;
    };
  };
  vm.runInThisContext(fs.readFileSync(new URL('../public/runtime/python-worker.js', import.meta.url), 'utf8'), {
    filename: 'production-python-worker.js',
  });

  async function execute(code, files = {}) {
    const id = 'actual-test-' + ++sequence;
    await globalThis.onmessage({ data: { type: 'execute', id, code, files } });
    const replies = messages.filter((message) => message.id === id);
    const result = replies.find((message) => message.type === 'result');
    assert.ok(result, 'the production worker emits a terminal result');
    return {
      ...result,
      stdout: replies.filter((message) => message.type === 'chunk' && message.stream === 'stdout').map((message) => message.text).join(''),
      stderr: replies.filter((message) => message.type === 'chunk' && message.stream === 'stderr').map((message) => message.text).join(''),
      messages: replies,
    };
  }

  await suite.test('real arithmetic and pinned runtime version', async () => {
    const result = await execute('1 + 1');
    assert.equal(runtime.version, '0.27.7');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, '2\n');
    assert.equal(result.executionCount, 1);
  });
  await suite.test('variables persist across cells and Unicode output is intact', async () => {
    const first = await execute('x = 40\nprint("你好，Python")');
    assert.equal(first.ok, true, first.error);
    assert.equal(first.stdout, '你好，Python\n');
    const second = await execute('x + 2');
    assert.equal(second.stdout, '42\n');
    assert.equal(second.executionCount, 3);
  });
  await suite.test('last-expression repr preserves integral floats', async () => {
    assert.equal((await execute('1.0')).stdout, '1.0\n');
  });
  await suite.test('real Python exceptions contain the source line', async () => {
    const result = await execute('1 / 0');
    assert.equal(result.ok, false);
    assert.match(result.error, /ZeroDivisionError: division by zero/);
    assert.match(result.error, /cell_5\.py/);
    assert.match(result.error, /1 \/ 0/);
  });
  await suite.test('input fails promptly and its prompt stays in its own cell', async () => {
    const result = await execute('input("数字：")');
    assert.equal(result.ok, false);
    assert.match(result.error, /本练习不支持交互式 input/);
    assert.equal(result.stdout, '数字：');
    assert.ok(result.elapsedMs < 1000, `input unexpectedly took ${result.elapsedMs} ms`);
  });
  await suite.test('same-length attachment changes invalidate imported modules', async () => {
    const first = await execute('import lesson_module\nlesson_module.value', { 'lesson_module.py': 'value = 41\n' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.stdout, '41\n');
    const second = await execute('import lesson_module\nlesson_module.value', { 'lesson_module.py': 'value = 42\n' });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.stdout, '42\n');
  });
  await suite.test('editing router.py changes an unchanged exam.py run in the same shared session', async () => {
    const exam = 'from router import reply\nprint(reply("account"))';
    const first = await execute('exec(open("exam.py").read())', { 'router.py': 'def reply(text):\n    return "old"\n', 'exam.py': exam });
    assert.equal(first.stdout, 'old\n');
    const changed = await execute('exec(open("exam.py").read())', { 'router.py': 'def reply(text):\n    return "new"\n', 'exam.py': exam });
    assert.equal(changed.ok, true, changed.error);
    assert.equal(changed.stdout, 'new\n');
  });
  await suite.test('stdout and stderr remain separate across cells', async () => {
    const result = await execute('import sys\nprint("标准输出")\nprint("标准错误", file=sys.stderr)');
    assert.equal(result.stdout, '标准输出\n');
    assert.equal(result.stderr, '标准错误\n');
  });
  await suite.test('globals are the real __main__ namespace', async () => {
    assert.equal((await execute('import __main__\n__main__.x')).stdout, '40\n');
  });
  await suite.test('standard-library dataclasses work', async () => {
    const result = await execute('from dataclasses import dataclass\n@dataclass\nclass Point:\n    x: int\nPoint(5)');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, 'Point(x=5)\n');
  });
  await suite.test('top-level await works', async () => {
    const result = await execute('import asyncio\nawait asyncio.sleep(0.01)\nx');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, '40\n');
  });
  await suite.test('partial output is flushed before the cell completes', async () => {
    assert.equal((await execute('print("无换行", end="")')).stdout, '无换行');
    assert.equal((await execute('print("下一个单元")')).stdout, '下一个单元\n');
  });
  await suite.test('long Chinese and emoji output survives UTF-8 buffer boundaries', async () => {
    const result = await execute('print("零基础学AI🌱" * 8000, end="")');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, '零基础学AI🌱'.repeat(8000));
    assert.ok(result.messages.filter((message) => message.type === 'chunk').length > 1);
  });

  await suite.test('list-of-records returns real structured table values, including hostile-looking plain text', async () => {
    const result = await execute('[{"姓名": "小周", "分数": x + 2}, {"姓名": "<img src=x onerror=alert(1)>", "分数": 7}]');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.messages.find(message => message.type === 'table').table, {
      columns: ['姓名', '分数'], rows: [['小周', '42'], ['<img src=x onerror=alert(1)>', '7']], truncated: false,
    });
  });
  await suite.test('display_table and display can emit multiple tables while variables remain shared', async () => {
    const result = await execute('display_table([[x, x + 1]], columns=["当前", "下一步"])\ndisplay([{"变量": x}])');
    assert.equal(result.ok, true, result.error);
    const tables = result.messages.filter(message => message.type === 'table').map(message => message.table);
    assert.deepEqual(tables, [
      { columns: ['当前', '下一步'], rows: [['40', '41']], truncated: false },
      { columns: ['变量'], rows: [['40']], truncated: false },
    ]);
  });
  await suite.test('large tables retain a bounded actual prefix and report truncation', async () => {
    const result = await execute('display_table([[n, n * n] for n in range(120)], columns=["n", "平方"])');
    assert.equal(result.ok, true, result.error);
    const table = result.messages.find(message => message.type === 'table').table;
    assert.equal(table.rows.length, 100);
    assert.equal(table.truncated, true);
    assert.deepEqual(table.rows[99], ['99', '9801']);
  });
  await suite.test('invalid custom columns fail explicitly instead of dropping values', async () => {
    const mismatch = await execute('display_table([[1,2]], columns=["a"])');
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /ValueError: columns 的数量必须与数据列数一致/);
    const string = await execute('display_table([[1,2]], columns="AB")');
    assert.equal(string.ok, false);
    assert.match(string.error, /TypeError: columns 必须是列名列表或元组/);
  });
  await suite.test('an error after changing a variable preserves actual Python state for the next cell', async () => {
    const failed = await execute('after_error = 41\nraise ValueError("试验失败")');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /ValueError: 试验失败/);
    assert.equal((await execute('after_error + 1')).stdout, '42\n');
  });

  const packages = JSON.parse(fs.readFileSync(root + 'pyodide-lock.json', 'utf8')).packages;
  const dependencies = new Set();
  function collect(name) {
    if (dependencies.has(name)) return;
    dependencies.add(name);
    packages[name].depends.forEach(collect);
  }
  collect('matplotlib');
  const matplotlibAvailable = [...dependencies].every((name) => fs.existsSync(root + packages[name].file_name));
  await suite.test('pandas DataFrame produces a structured table from real values', {
    skip: !fs.existsSync(root + packages.pandas.file_name) && 'Download pandas and dependencies to enable the DataFrame test.',
  }, async () => {
    const result = await execute('import pandas as pd\npd.DataFrame({"name": ["A", "B"], "score": [x, x+2]})');
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.messages.find(message => message.type === 'table').table, {
      columns: ['索引', 'name', 'score'], rows: [['0', 'A', '40'], ['1', 'B', '42']], truncated: false,
    });
  });
  await suite.test('matplotlib emits a real PNG', {
    skip: !matplotlibAvailable && 'Download matplotlib and its lockfile dependencies to enable the PNG test.',
  }, async () => {
    const result = await execute('import matplotlib.pyplot as plt\nplt.plot([1,2,3], [2,4,8])\nplt.title("Real plot")\nplt.show()');
    assert.equal(result.ok, true, result.error);
    const chart = result.messages.find((message) => message.type === 'image');
    assert.ok(chart, 'a PNG image is emitted');
    const bytes = Buffer.from(chart.data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(bytes.length > 1000, 'the PNG contains rendered plot data');
  });
  await suite.test('a plot made before an exception stays with its failed cell and does not leak forward', {
    skip: !matplotlibAvailable && 'Download matplotlib and its dependencies to enable the PNG test.',
  }, async () => {
    const failed = await execute('plt.plot([1,2],[4,8])\nraise ValueError("after plot")');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /ValueError: after plot/);
    assert.equal(failed.messages.filter(message => message.type === 'image').length, 1);
    const next = await execute('print("next cell")');
    assert.equal(next.ok, true, next.error);
    assert.equal(next.messages.filter(message => message.type === 'image').length, 0);
  });
});

test('real WASM execution can be terminated and a new worker has a clean namespace', {
  skip: !assetDirectory && 'Set NOTEBOOK_PYODIDE_DIR to the fixed-version runtime asset directory.', timeout: 30000,
}, async () => {
  const root = path.resolve(assetDirectory) + path.sep;
  const source = fs.readFileSync(new URL('../public/runtime/python-worker.js', import.meta.url), 'utf8');
  const startWorker = () => new Worker(`
    const { parentPort } = require('node:worker_threads');
    const actual = require(${JSON.stringify(root + 'pyodide.js')});
    globalThis.self = globalThis;
    globalThis.postMessage = message => parentPort.postMessage(message);
    globalThis.importScripts = () => { globalThis.loadPyodide = options => actual.loadPyodide({...options, indexURL: ${JSON.stringify(root)}}); };
    ${source}
    parentPort.on('message', data => globalThis.onmessage({data}));
  `, { eval: true });
  const waitFor = (worker, id, type) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Real worker did not reach ' + type)); }, 10000);
    const cleanup = () => { clearTimeout(timeout); worker.off('message', onMessage); worker.off('error', onError); };
    const onError = error => { cleanup(); reject(error); };
    const onMessage = message => { if (message.id === id && message.type === type) { cleanup(); resolve(message); } };
    worker.on('message', onMessage); worker.on('error', onError);
  });
  const first = startWorker();
  try {
    const started = waitFor(first, 'loop', 'started');
    first.postMessage({ type: 'execute', id: 'loop', code: 'x = 99\nwhile True:\n    pass' });
    await started;
    await first.terminate();
  } finally { await first.terminate(); }
  const fresh = startWorker();
  try {
    const failed = waitFor(fresh, 'fresh', 'result');
    fresh.postMessage({ type: 'execute', id: 'fresh', code: 'x' });
    const failure = await failed;
    assert.equal(failure.ok, false);
    assert.match(failure.error, /NameError/);
    const recovered = waitFor(fresh, 'recovered', 'result');
    const chunks = [];
    fresh.on('message', message => { if (message.id === 'recovered' && message.type === 'chunk') chunks.push(message.text); });
    fresh.postMessage({ type: 'execute', id: 'recovered', code: 'print(6 * 7)' });
    assert.equal((await recovered).ok, true);
    assert.equal(chunks.join(''), '42\n');
  } finally { await fresh.terminate(); }
});
