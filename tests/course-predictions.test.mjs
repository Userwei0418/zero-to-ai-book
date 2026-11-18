import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { comparePrediction, coursePredictions, withCoursePredictions } from '../lib/course-predictions.ts';
import { paginateMeasuredBlocks } from '../components/book-pagination.ts';

const chapter = JSON.parse(fs.readFileSync(new URL('../public/course/chapters/upper-01.json', import.meta.url), 'utf8'));
const exercise = coursePredictions['upper-01'][0];
const result = (stdout, options = {}) => ({ code: 'edited code', status: 'ok', stdout, stderr: '', images: [], ...options });

test('source-linked activities preserve every original block, text, ID and order', () => {
  const combined = withCoursePredictions(chapter.id, chapter.blocks);
  assert.equal(combined.length, chapter.blocks.length + 3);
  assert.deepEqual(combined.filter(block => block.type !== 'prediction'), chapter.blocks);
  for (const activity of coursePredictions[chapter.id]) {
    const index = combined.findIndex(block => block.id === activity.id);
    assert.equal(combined[index - 1].id, activity.afterBlockId);
    const code = chapter.blocks.find(block => block.id === activity.cellId);
    assert.equal(code.type, 'code');
    assert.equal(code.runnable, true);
    assert.match(code.code, /run\(reply/);
  }
  assert.deepEqual(withCoursePredictions(chapter.id, combined), combined, 'repeat enrichment cannot duplicate activities');
  assert.deepEqual(withCoursePredictions('unrelated-chapter', chapter.blocks), chapter.blocks);
});

test('a prediction never reveals a score before a successful current execution', () => {
  for (const candidate of [undefined, result('3/6', { status: 'running' }), result('3/6', { status: 'error' }), result('3/6', { status: 'interrupted' }), result('3/6', { historical: true }), result('3/6', { code: 'old code' }), result('3/6', { inputsChanged: true })]) {
    const value = comparePrediction(exercise, '2', 'edited code', candidate);
    assert.notEqual(value.kind, 'actual');
    assert.equal(value.score, undefined);
    assert.equal(value.matches, undefined);
  }
  assert.equal(comparePrediction(exercise, '2', 'edited code', result('3/6', { historical: true, inputsChanged: true })).kind, 'historical', 'restored history must not be presented as a new code edit');
});

test('comparison follows real stdout rather than the source lesson answer', () => {
  const changed = comparePrediction(exercise, '6', 'edited code', result('✓ a\n✓ b\n6/6\n'));
  assert.equal(changed.score, 6);
  assert.equal(changed.matches, true);
  assert.equal(comparePrediction(exercise, '2', 'edited code', result('3/6')).matches, false);
  assert.equal(comparePrediction(exercise, '', 'edited code', result('3/6')).matches, undefined);
});

test('the six-question prediction is not confused by a later two-question score', () => {
  const value = comparePrediction(exercise, '4', 'edited code', result('4/6\n——新问题——\n0/2\n'));
  assert.equal(value.score, 4);
  for (const stdout of ['0/2', '7/6', 'score changed', '课程示例：3/6']) {
    assert.equal(comparePrediction(exercise, '3', 'edited code', result(stdout)).kind, 'unrecognized');
  }
  const repeated = comparePrediction(exercise, '6', 'edited code', result('3/6\n修改规则后\n6/6\n'));
  assert.equal(repeated.kind, 'unrecognized', 'multiple runs must not silently select the first score');
  assert.equal(repeated.score, undefined);
});

const readChapter = id => JSON.parse(fs.readFileSync(new URL(`../public/course/chapters/${id}.json`, import.meta.url), 'utf8'));

test('source-linked exercises compare the actual Python output in four chapters', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const expected = { 'upper-01': ['3', '3', '4'], 'upper-02': ['same'], 'upper-06': ['pass'], 'upper-13': ['1'] };
  for (const [chapterId, exercises] of Object.entries(coursePredictions)) {
    const source = readChapter(chapterId);
    const enriched = withCoursePredictions(chapterId, source.blocks);
    assert.deepEqual(enriched.filter(block => block.type !== 'prediction'), source.blocks);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-prediction-'));
    try {
      for (const [name, content] of Object.entries(source.files || {})) {
        const filename = path.join(directory, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
      }
      exercises.forEach((activity, i) => {
        const target = source.blocks.find(block => block.id === activity.cellId);
        assert.ok(target.runnable && target.runtime === 'browser');
        assert.ok(activity.reflect && activity.challenge);
        const choice = expected[chapterId][i];
        const execution = spawnSync('python3', ['-c', target.code], { cwd: directory, encoding: 'utf8' });
        assert.equal(execution.status, 0, execution.stderr);
        const comparison = comparePrediction(activity, choice, target.code, result(execution.stdout, { code: target.code }));
        assert.equal(comparison.kind, 'actual', activity.id);
        assert.equal(comparison.matches, true, `${activity.id}: ${comparison.message}`);
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('editing each new experiment can change the observed answer; partial and repeated outputs are ambiguous', () => {
  const readings = [
    ['upper-02', 'less', '楼梯灯｜练 20 轮：最后一轮错 3 题\n楼梯灯｜练 1000 轮：最后一轮错 1 题'],
    ['upper-06', 'fail', "排队办 ('安装：不能在审批办完之前开始', None)"],
    ['upper-13', '2', '【同一条通知送来了两遍】\n   多四道检查：办了 2 回：检查；检查\n\n【办到一半，断电重启】\n   多四道检查：办了 1 回：检查'],
  ];
  for (const [chapterId, choice, stdout] of readings) {
    const activity = coursePredictions[chapterId][0];
    assert.equal(comparePrediction(activity, choice, 'edited code', result(stdout)).matches, true);
    assert.equal(comparePrediction(activity, choice, 'edited code', result(stdout + '\n' + stdout)).kind, 'unrecognized');
    assert.equal(comparePrediction(activity, choice, 'edited code', result('完成')).kind, 'unrecognized');
    assert.equal(comparePrediction(activity, choice, 'edited code', result(stdout, { inputsChanged: true })).kind, 'stale');
  }
});

test('the compact measured card uses the bottom of a page, with narrower cards moving intact', () => {
  const paragraph = { block: { id: 'paragraph', type: 'prose' }, text: '正文', lineHeight: 20, measure: () => 221, slice: () => '正文' };
  const prediction = height => ({ block: { id: exercise.id, type: 'prediction' }, text: '', lineHeight: 20, measure: () => height, slice: () => '', atomic: { preferred: height, minimum: height } });
  assert.equal(paginateMeasuredBlocks([paragraph, prediction(114)], 360).length, 1);
  const pages = paginateMeasuredBlocks([paragraph, prediction(151)], 360);
  assert.equal(pages.length, 2);
  assert.equal(pages[1][0].height, 151);
});
