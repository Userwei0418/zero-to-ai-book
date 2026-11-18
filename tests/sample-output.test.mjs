import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { withCoursePredictions, coursePredictions } from '../lib/course-predictions.ts';
import { isSampleOutput, markPredictionSamples } from '../lib/sample-output.ts';

test('only the matching printed answers collapse and all original reading anchors survive', () => {
  for (const [id, exercises] of Object.entries(coursePredictions)) {
    const chapter = JSON.parse(readFileSync(new URL(`../public/course/chapters/${id}.json`, import.meta.url)));
    const source = withCoursePredictions(id, chapter.blocks);
    const reading = markPredictionSamples(source);
    assert.deepEqual(reading.map(block => block.id), source.map(block => block.id));
    const samples = reading.filter(isSampleOutput);
    assert.equal(samples.length, exercises.length);
    assert.ok(samples.every(block => block.type === 'code' && !block.runnable && block.code));
    assert.ok(!chapter.blocks.some(isSampleOutput));
  }
});
