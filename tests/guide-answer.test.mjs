import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGuideAnswer } from '../components/guide-answer.ts';
import { guideMessage } from '../lib/guide-message.ts';
import { validateLearningState } from '../lib/learning-state-validation.ts';

const source = {chapterId:'upper-intro', blockId:'upper-intro-abc', title:'怎样接续工作', excerpt:'章节中的具体例子。'};
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {headers:{'content-type':'text/event-stream'}});
test('a streamed reply, model and original passage survive save, export and restore', async () => {
  const updates = [];
  const message = await readGuideAnswer(sse([
    {type:'delta',text:'第'}, {type:'delta',text:'一步'}, {type:'done',model:'my-model',sources:[source]},
  ]), text => updates.push(text));
  assert.deepEqual(updates,['第','第一步']);
  const state = {chats:{chapter:[{role:'user',content:'一个问题'},message]}};
  const saved = validateLearningState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(saved.chats.chapter.flatMap(guideMessage), state.chats.chapter);
  const legacy = {role:'assistant',content:'旧回答'};
  assert.deepEqual(guideMessage(legacy),[legacy]);
});
test('incomplete client streams cannot become completed answers', async () => {
  await assert.rejects(readGuideAnswer(sse([{type:'delta',text:'还没写完'}]),()=>{}),/中断/);
  await assert.rejects(readGuideAnswer(sse([{type:'error',message:'private detail'}]),()=>{}),/回答中断/);
});
