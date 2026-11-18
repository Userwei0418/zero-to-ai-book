import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chapterExperimentRecords } from '../lib/experiment-records.ts';
import { readChapterRunHistory, getNotebookKernel, subscribeRunHistory } from '../lib/notebook-runtime.ts';
import { resolvePageLocation } from '../components/book-pagination.ts';

const course = async (id) => JSON.parse(await readFile(new URL('../public/course/chapters/'+id+'.json', import.meta.url)));

test('imported edits, empty files, saved runs, and cross-chapter anchors resolve against real course units', async () => {
  const first = await course('upper-01');
  const second = await course('upper-02');
  const router = first.blocks.find(block => block.filename === 'router.py');
  const restored = first.blocks.find(block => block.filename === 'exam.py');
  const target = second.blocks.find(block => block.filename === 'perceptron.py');
  const state = JSON.parse(JSON.stringify({
    codes: {
      [first.id + ':' + router.id]: '',
      [first.id + ':' + restored.id]: restored.code,
      [second.id + ':' + target.id]: 'print("my edit")',
      [second.id + ':deleted-course-cell']: 'print(0)',
    },
    files: {
      [first.id]: { 'router.py': '', 'notes.txt': '', 'exam.py': first.files['exam.py'] },
    },
  }));
  const rows = chapterExperimentRecords(first, state, { [router.id]: { status: 'error', historical: true } });
  assert.equal(rows.length, 2, 'restored originals and edits mirrored to a linked project file do not create extra entries');
  assert.equal(rows[0].anchor, router.id);
  assert.equal(rows[0].edited, true);
  assert.deepEqual(rows[0].run, { status: 'error', historical: true });
  assert.equal(rows[1].filename, 'notes.txt');
  assert.equal(rows[1].unit, 'upper-01-file-notes.txt');

  const [other] = chapterExperimentRecords(second, state, {});
  assert.equal(other.chapterId, 'upper-02');
  assert.equal(other.unit, target.id);
  const pages = second.blocks.map(block => [{ block, anchor: block.id }]);
  const jumped = resolvePageLocation(pages, other.anchor, 2);
  assert.ok(pages.slice(jumped.page, jumped.page + 2).flat().some(part => part.block.id === target.id));
  const fileRows = chapterExperimentRecords(first, state, { 'upper-01-file-router.py': { status: 'ok', historical: false } });
  const directFile = fileRows.find(row => row.filename === 'router.py');
  assert.equal(directFile.anchor, router.id);
  assert.equal(directFile.run.historical, false);
  const fromCellOnly = chapterExperimentRecords(first, { codes: state.codes }, { 'upper-01-file-router.py': { status: 'ok', historical: true } });
  assert.equal(fromCellOnly.find(row => row.filename === 'router.py')?.edited, true,
    'the project file editor uses the effective cell edit even without a separate file override');
});

test('reading another chapter history is read-only and scoped, preserves live sessions, and tolerates v1 caches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values = new Map();
  const define = (key, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  };
  define('window', {});
  define('localStorage', {
    getItem: key => values.get(key) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k=>values.delete(k),
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', stdout:'7', stderr:'', executionCount:1 }));
  const scope = 'student:/one';
  const run = { code:'print(7)', stdout:'7', stderr:'', status:'error' };
  values.set('ai-book-results-v1:'+scope+':upper-02', JSON.stringify({ previous: run, incomplete: { status:'ok' } }));
  values.set('ai-book-results-v2:'+encodeURIComponent(scope)+':upper-03', '{broken');
  const live = getNotebookKernel('upper-01', scope);
  const registered = { block: { id:'live', type:'code', runnable:true, runtime:'linux', code:'print(7)' }, value:'print(7)' };
  live.registerAll([registered]);
  live.setRemoteConfigured(true);
  let events = 0;
  const unsubscribe = subscribeRunHistory(scope, () => events++);
  await live.execute(registered);
  unsubscribe();
  assert.ok(events > 0);
  assert.deepEqual(readChapterRunHistory(scope, 'upper-01').live, {status:'ok', historical:false});
  assert.deepEqual(readChapterRunHistory(scope, 'upper-02').previous, {status:'error', historical:true});
  assert.equal(readChapterRunHistory(scope, 'upper-02').incomplete, undefined);
  assert.deepEqual(readChapterRunHistory('different-student', 'upper-02'), {});
  assert.deepEqual(readChapterRunHistory('pending', 'upper-02'), {});
  for (const chapter of ['upper-03', 'upper-04', 'upper-05', 'upper-06']) assert.deepEqual(readChapterRunHistory(scope, chapter), {});
  assert.equal(getNotebookKernel('upper-01', scope), live, 'reading the drawer left the live kernel in memory');
  assert.equal(values.size, 2, 'listing previous chapters did not migrate or rewrite cache data');
});
