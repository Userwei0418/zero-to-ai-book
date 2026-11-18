/**
 * All browser-classified course cells, through the unchanged production worker
 * and real Pyodide 0.27.7 WASM. Each cell gets a new Node worker / Python kernel.
 * Only browser importScripts + CDN asset lookup are adapted to an offline copy.
 * No browser/preview server and no CPython subprocess are involved.
 *
 * NOTEBOOK_PYODIDE_DIR=/tmp/notebook-pyodide-test node --test tests/course-pyodide.test.mjs
 * Every cell has the same 60-second hard wall-clock limit as the Notebook UI.
 * The report is written even if some cells fail. Missing assets explicitly skip.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { test } from 'node:test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const productionPath = path.join(root, 'public/runtime/python-worker.js');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const LIMIT_MS = 60000;

if (!isMainThread) {
  const messages = [];
  let runtime;
  try {
    const assets = path.resolve(workerData.assets) + path.sep;
    const require = createRequire(import.meta.url);
    const actualPyodide = require(assets + 'pyodide.js');
    globalThis.self = globalThis;
    globalThis.postMessage = (message) => {
      messages.push(message);
      if (message.type === 'chunk') parentPort.postMessage({ kind: 'chunk', stream: message.stream, text: message.text });
    };
    globalThis.importScripts = (url) => {
      assert.equal(url, 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
      globalThis.loadPyodide = async (options) => {
        runtime = await actualPyodide.loadPyodide({ ...options, indexURL: assets });
        return runtime;
      };
    };
    vm.runInThisContext(fs.readFileSync(productionPath, 'utf8'), { filename: 'production-python-worker.js' });
    await globalThis.onmessage({ data: { type: 'execute', id: workerData.task.blockId, code: workerData.task.code, filename: workerData.task.filename, files: workerData.task.files } });
    const result = messages.find((m) => m.type === 'result');
    parentPort.postMessage({
      kind: 'done',
      result: result || { ok: false, error: 'Production worker emitted no terminal result.' },
      runtimeVersion: runtime?.version || null,
      statuses: messages.filter((m) => m.type === 'status').map((m) => m.message),
      imageCount: messages.filter((m) => m.type === 'image').length,
    });
  } catch (error) {
    parentPort.postMessage({ kind: 'done', result: { ok: false, error: String(error?.stack || error) }, runtimeVersion: runtime?.version || null });
  }
} else {
  const assetDirectory = process.env.NOTEBOOK_PYODIDE_DIR;
  test('all browser course cells execute through the real production Pyodide worker', {
    skip: !assetDirectory && 'Set NOTEBOOK_PYODIDE_DIR to the fixed Pyodide 0.27.7 asset directory.',
    timeout: 35 * LIMIT_MS,
  }, async (suite) => {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'public/course/index.json'), 'utf8'));
    const tasks = [];
    for (const info of index.chapters) {
      const chapter = JSON.parse(fs.readFileSync(path.join(root, `public/course/chapters/${info.id}.json`), 'utf8'));
      for (const block of chapter.blocks) {
        if (block.runnable && block.runtime === 'browser') tasks.push({
          chapterId: chapter.id, blockId: block.id, filename: block.filename || null,
          code: block.code, files: chapter.files || {},
        });
      }
    }
    assert.equal(tasks.length, index.assets.browserRunnable, 'every published browser-runnable cell is included');
    assert.ok(tasks.length > 0, 'the course test contains executable cells');
    const started = performance.now();
    const report = {
      checkedAt: new Date().toISOString(),
      displayDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date()),
      engine: 'Pyodide 0.27.7 / CPython 3.12 WASM, production python-worker.js under Node Worker threads',
      nodeVersion: process.version,
      productionWorkerSha256: hash(fs.readFileSync(productionPath)),
      runtimeAssets: Object.fromEntries(['pyodide.js','pyodide.asm.js','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json'].map((name) => [name, hash(fs.readFileSync(path.join(assetDirectory, name)))])),
      isolation: 'A new Node Worker and Pyodide kernel per course cell; the exact chapter.files are mounted by production syncFiles().',
      timeoutMs: LIMIT_MS,
      scope: 'Real WASM execution and course module loading. Browser iframe/CSP and interactive UI behavior are not exercised by this Node suite.',
      total: tasks.length, passed: 0, failed: 0, results: [],
    };
    function runOne(task) {
      return new Promise((resolve) => {
        const start = performance.now();
        let stdout = '', stderr = '', finished = false;
        const worker = new Worker(new URL(import.meta.url), { workerData: { assets: assetDirectory, task } });
        const finish = async (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          await worker.terminate();
          const record = {
            chapterId: task.chapterId, blockId: task.blockId, filename: task.filename,
            codeSha256: hash(task.code),
            chapterFilesSha256: hash(JSON.stringify(Object.entries(task.files).sort(([a],[b]) => a.localeCompare(b)))),
            fileCount: Object.keys(task.files).length,
            ...result, stdout, stderr, wallElapsedMs: Math.round(performance.now() - start),
          };
          resolve(record);
        };
        const timer = setTimeout(() => finish({ passed: false, result: 'timeout', error: 'Exceeded the 60-second Notebook limit.', runtimeVersion: null }), LIMIT_MS);
        worker.on('message', (message) => {
          if (message.kind === 'chunk') {
            if (message.stream === 'stderr') stderr += message.text;
            else stdout += message.text;
          } else if (message.kind === 'done') finish({
            passed: message.result.ok === true && message.runtimeVersion === '0.27.7' && message.result.executionCount === 1,
            result: message.result.ok ? 'completed' : 'python-error',
            runtimeVersion: message.runtimeVersion,
            executionCount: message.result.executionCount ?? null,
            workerElapsedMs: message.result.elapsedMs ?? null,
            error: message.result.error || null,
            imageCount: message.imageCount || 0,
          });
        });
        worker.on('error', (error) => finish({ passed: false, result: 'worker-error', error: String(error.stack || error), runtimeVersion: null }));
        worker.on('exit', (code) => {
          if (!finished) finish({ passed: false, result: 'worker-exit', error: `Node worker exited (${code}) before the production result.`, runtimeVersion: null });
        });
      });
    }
    let cursor = 0;
    const results = new Array(tasks.length);
    async function consumer() {
      while (cursor < tasks.length) {
        const position = cursor++;
        results[position] = await runOne(tasks[position]);
        const r = results[position];
        suite.diagnostic(`${r.passed ? 'PASS' : 'FAIL'} ${r.chapterId}/${r.filename} ${r.wallElapsedMs} ms`);
      }
    }
    await Promise.all([consumer(), consumer()]);
    report.results = results;
    report.passed = results.filter((r) => r.passed).length;
    report.failed = report.total - report.passed;
    report.elapsedMs = Math.round(performance.now() - started);
    assert.equal(hash(fs.readFileSync(productionPath)), report.productionWorkerSha256, 'production worker did not change during the course execution suite');
    // Browser-classified cells contain no credentials; never publish an unexpected token.
    const encoded = JSON.stringify(report, null, 2) + '\n';
    assert.ok(!/\bsk-[A-Za-z0-9_-]{18,}|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(encoded), 'output contains no private key or long API key token');
    fs.writeFileSync(path.join(root, 'public/course/pyodide-validation.json'), encoded);
    const failures = results.filter((r) => !r.passed).map((r) => `${r.chapterId}/${r.filename}: ${r.error}`).join('\n');
    assert.equal(report.failed, 0, failures);
    assert.ok(results.every((r) => r.executionCount === 1), 'every cell uses an isolated fresh kernel');
  });
}
