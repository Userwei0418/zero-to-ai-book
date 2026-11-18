import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExperiment, decodeExperimentSupport } from '../lib/experiment-export.ts';

function chapter(id) {
  const course = JSON.parse(readFileSync(new URL(`../public/course/chapters/${id}.json`, import.meta.url), 'utf8'));
  return { chapterId: id, files: { ...course.files }, originals: course.files, results: {},
    cells: course.blocks.filter(block => block.type === 'code').map(block => ({ block, value: block.code })) };
}
function python(dir, ...args) {
  const result = spawnSync('python3', args, { cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONPATH: '', PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
async function extract(dir, input) {
  writeFileSync(join(dir, 'experiment.zip'), new Uint8Array(await createExperiment(input, 'zip').arrayBuffer()));
  python(dir, '-m', 'zipfile', '-e', 'experiment.zip', '.');
}
function empty(t) {
  const dir = mkdtempSync(join(tmpdir(), 'experiment-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('edited upper-01 ZIP runs from an empty directory, standalone notebooks and scripts restore modules', async t => {
  const input = chapter('upper-01');
  const router = input.cells.find(cell => cell.block.filename === 'router.py');
  router.value += '\nprint("from web editor")';
  input.files['router.py'] = router.value;
  input.files['README.md'] = 'reader file';
  input.files['run.py'] = 'reader file';
  const dir = empty(t);
  await extract(dir, input);
  assert.equal(readFileSync(join(dir, 'project/router.py'), 'utf8'), router.value);
  assert.equal(readFileSync(join(dir, 'project/README.md'), 'utf8'), 'reader file');
  assert.equal(readFileSync(join(dir, 'project/run.py'), 'utf8'), 'reader file');
  assert.match(python(dir, 'run.py'), /from web editor[\s\S]*3\/6[\s\S]*4\/6/);
  assert.match(python(dir, 'run.py', '2'), /3\/6/);
  const separate = join(dir, 'separate'); mkdirSync(separate);
  writeFileSync(join(separate, 'lesson.py'), await createExperiment(input, 'py').text());
  assert.match(python(separate, 'lesson.py'), /from web editor[\s\S]*4\/6/);
  writeFileSync(join(separate, 'lesson.ipynb'), await createExperiment(input, 'ipynb').text());
  const runNotebook = 'import json,sys\nctx={"__name__": "__main__"}\nfor c in json.load(open(sys.argv[1], encoding="utf8"))["cells"]:\n if c["cell_type"]=="code":exec(compile(c["source"],"<cell>","exec"),ctx)';
  assert.match(python(separate, '-c', runNotebook, 'lesson.ipynb'), /from web editor[\s\S]*4\/6/);
  assert.match(python(dir, '-c', runNotebook, 'chapter.ipynb'), /from web editor[\s\S]*4\/6/);
});

test('lower-12 ZIP resolves cross-chapter chunks, skills, corpus and edited modules offline', async t => {
  const input = chapter('lower-12');
  input.support = decodeExperimentSupport(readFileSync(new URL('../public/course/experiment-support.zip', import.meta.url)));
  input.files['memory.py'] += '\nexport_test = True';
  const dir = empty(t);
  await extract(dir, input);
  const root = join(dir, '下册/课件');
  assert.match(readFileSync(join(root, 'ch09/memory.py'), 'utf8'), /export_test = True/);
  assert.match(readFileSync(join(root, 'ch03/chunks.jsonl'), 'utf8'), /"start_line"/);
  assert.match(readFileSync(join(root, 'ch11/eval_set.json'), 'utf8'), /\[/);
  assert.match(python(root, 'ch12/mykb_pkg/mykb/cli.py', 'stats'), /25/);
  assert.match(python(dir, 'run.py', '--list'), /cli.py/);
  const notebook = JSON.parse(await createExperiment(input, 'ipynb').text());
  assert.ok(notebook.cells.some(cell => cell.source?.includes('ch12/mykb_pkg/mykb/cli.py')));
});

test('requirements include recognized packages imported by edited helper modules', async t => {
  const input = chapter('upper-01');
  input.files['helper.py'] = 'import numpy as np, pandas as pd';
  input.cells[0].value = 'from helper import something';
  const dir = empty(t);
  await extract(dir, input);
  assert.match(readFileSync(join(dir, 'requirements.txt'), 'utf8'), /^numpy\npandas$/m);
});

test('unsafe file paths and missing lower-volume assets cannot silently produce incomplete exports', () => {
  const input = chapter('upper-01');
  for (const name of ['../outside.py', '/tmp/foo.py', 'x\\escape.py', 'test.py/child.py', 'TEST.PY']) {
    assert.throws(() => createExperiment({ ...input, files: { 'test.py': '', [name]: 'x' } }, 'zip'), /路径|冲突/);
  }
  assert.throws(() => createExperiment(chapter('lower-03'), 'zip'), /缺少/);
});
