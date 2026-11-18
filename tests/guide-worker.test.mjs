/**
 * Execute the actual guide route in workerd with a real local D1 database.
 * Only the external model HTTP response is mocked; no paid requests are made.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse, createFetchMock } from 'miniflare';

const built = await build({
  stdin: { contents: "import { POST } from './app/api/guide/route.ts'; export default {fetch: POST};", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], tsconfig: 'tsconfig.json',
});
const migrations = await Promise.all(['drizzle/0000_mute_silhouette.sql', 'drizzle/0001_fantastic_corsair.sql'].map(file => readFile(file, 'utf8')));
async function setup(t, { migrate = true, outboundService } = {}) {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const mf = new Miniflare({
    script: built.outputFiles[0].text, modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    bindings: { TOKENPLAN_API_KEY: 'test-key-never-real', TOKENPLAN_MODEL: 'test-model' }, d1Databases: ['DB'], ...(outboundService ? { outboundService } : { fetchMock }),
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  if (migrate) for (const migration of migrations) for (const sql of migration.split('--> statement-breakpoint')) await db.exec(sql.replace(/\n/g, ' '));
  const request = (question = '请用一句话解释 Harness', { body, authenticated = true, stream = false, signal } = {}) => mf.dispatchFetch('https://guide.test/api/guide', {
    method: 'POST', signal, headers: { ...(stream ? {accept: 'text/event-stream'} : {}), origin: 'https://guide.test', 'content-type': 'application/json', ...(authenticated ? { 'oai-authenticated-user-id': 'local-test-learner' } : {}) },
    body: body ?? JSON.stringify({ chapterId: 'upper-intro', question }),
  });
  return { mock: fetchMock, request, db };
}

test('guide sends a real workerd fetch and caches its readable response', async t => {
  const { mock, request } = await setup(t);
  let calls = 0;
  mock.get('https://token.sensetime.com').intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(200, () => {
    calls++;
    return { choices: [{ message: { content: 'Harness 是安排模型、工具与工作步骤的执行层。' } }], model: 'test-model' };
  }).persist();
  const first = await request();
  assert.equal(first.status, 200);
  const payload = await first.json();
  assert.match(payload.answer, /Harness/);
  assert.equal(payload.model, 'test-model');
  assert.ok(payload.sources.length > 0);
  const cached = await request();
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cached, true);
  assert.equal(calls, 1, 'a cache hit does not issue a second upstream request');
});

test('guide rejects a redirect and never sends its credential to the redirect destination', async t => {
  let redirected = false;
  // Return the redirect at the workerd service boundary. Undici's mock adapter
  // follows redirects itself, which would not exercise the Worker fetch policy.
  const { request } = await setup(t, { outboundService: async request => {
    if (new URL(request.url).hostname === 'other.test') { redirected = true; return WorkerResponse.json({}); }
    return new WorkerResponse(null, { status: 307, headers: { location: 'https://other.test/collect' } });
  } });
  const response = await request();
  assert.equal(response.status, 502);
  const redirectPayload = await response.json();
  assert.equal(redirectPayload.code, 'upstream_redirect', JSON.stringify(redirectPayload));
  assert.equal(redirected, false);
});

test('guide distinguishes provider credentials and rate limits', async t => {
  const { mock, request } = await setup(t);
  const pool = mock.get('https://token.sensetime.com');
  pool.intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(401, { error: 'provider-private-detail' });
  const unauthorized = await request('第一问');
  assert.equal(unauthorized.status, 502);
  const invalidCredential = await unauthorized.json();
  assert.equal(invalidCredential.upstreamStatus, 401);
  assert.match(invalidCredential.error, /凭据/);
  assert.ok(!JSON.stringify(invalidCredential).includes('provider-private-detail'));
  pool.intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(429, {});
  const limited = await request('第二问');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).upstreamStatus, 429);
});

test('guide distinguishes invalid provider output without exposing raw response data', async t => {
  const { mock, request } = await setup(t);
  mock.get('https://token.sensetime.com').intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(200, '<private-provider-error>');
  const response = await request();
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.code, 'upstream_response_invalid');
  assert.ok(!JSON.stringify(payload).includes('private-provider-error'));
});

test('guide reports missing D1 schema as storage failure before calling a model', async t => {
  const { request } = await setup(t, { migrate: false });
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'guide_storage_unavailable');
});

test('guide validates malformed JSON and preserves the authentication boundary', async t => {
  const { request } = await setup(t);
  const malformed = await request('', { body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid_request');
  const anonymous = await request('', { authenticated: false });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'sign_in_required');
});

const encoder = new TextEncoder();
const data = object => 'data: ' + JSON.stringify(object) + '\r\n\r\n';
const token = text => ({ model: 'streamed-model', choices: [{index: 0, delta: {content: text}}] });
test('guide passes through visible text before the provider finishes and saves navigable sources', async t => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  const {request, db} = await setup(t, {outboundService: async req => {
    assert.equal((await req.json()).stream, true);
    return new WorkerResponse(new ReadableStream({
      async start(controller) {
        const text = encoder.encode(': heartbeat\r\n\r\n' +
          data({ choices: [{delta: {reasoning_content: 'provider-internal'}}] }) + data(token('你')));
        // Split inside the three-byte UTF-8 character.
        const split = text.indexOf(0xe4) + 1;
        controller.enqueue(text.slice(0,split));
        controller.enqueue(text.slice(split));
        await gate;
        controller.enqueue(encoder.encode(data(token('好')) + 'data: [DONE]\n\n'));
        controller.close();
      },
    }), {headers: {'content-type':'text/event-stream; charset=utf-8'}});
  }});
  const response = await request('流式', {stream:true});
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  const head = new TextDecoder().decode(first.value);
  assert.match(head, /"text":"你"/);
  assert.doesNotMatch(head, /provider-internal|"type":"done"/);
  resume();
  let wire = head;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    wire += new TextDecoder().decode(next.value);
  }
  const events = wire.trim().split(/\n\n/).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '你好');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.model, 'streamed-model');
  assert.ok(done.sources.every(s => s.blockId && s.excerpt && s.title));
  const cached = await (await request('流式', {stream:true})).json();
  assert.equal(cached.answer, '你好'); assert.deepEqual(cached.sources, done.sources);
  assert.equal((await db.prepare("SELECT COALESCE(SUM(count),0) AS count FROM request_quota WHERE key LIKE 'guide-day:%'").first()).count, 1);
});

test('a partial provider response never becomes a saved answer or uses a daily credit', async t => {
  const {request, db} = await setup(t, {outboundService: async () =>
    new WorkerResponse(data(token('部分答案')), {headers: {'content-type':'text/event-stream'}})
  });
  const response = await request('中断', {stream:true});
  const wire = await response.text();
  assert.match(wire, /"type":"delta"/); assert.match(wire, /"type":"error"/); assert.doesNotMatch(wire, /"type":"done"/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM guide_cache').first()).count, 0);
  assert.equal((await db.prepare("SELECT COALESCE(SUM(count),0) AS count FROM request_quota WHERE key LIKE 'guide-day:%'").first()).count, 0);
});

test('a provider returning JSON to a streaming client stays compatible', async t => {
  const {request} = await setup(t, {outboundService: async () =>
    WorkerResponse.json({choices: [{message:{content:'整段回答'}}]})
  });
  const response = await request('整段', {stream:true});
  assert.equal((await response.json()).answer, '整段回答');
});

test('stopping a streamed response releases its reservation and prevents a partial cache entry', {timeout:12000}, async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const {request,db} = await setup(t, {outboundService: async () =>
    new WorkerResponse(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(data(token('初始回答'))));
        await gate;
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
        } catch { /* Upstream was cancelled by the worker. */ }
      },
    }), {headers:{'content-type':'text/event-stream'}})
  });
  const requestId = crypto.randomUUID();
  const response = await request('主动停止', {stream:true, body:JSON.stringify({chapterId:'upper-intro', question:'主动停止', requestId})});
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"delta"/);
  const stopped = await request('', {body: JSON.stringify({action:'cancel',requestId})});
  assert.equal((await stopped.json()).stopped, true);
  finish();
  // Even a proxy that keeps the original connection open cannot complete a stopped answer.
  let tail = '';
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.doesNotMatch(tail, /"type":"done"/);
  const count = (await db.prepare("SELECT COALESCE(SUM(count),0) AS count FROM request_quota WHERE key LIKE 'guide-day:%'").first()).count;
  assert.equal(count,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM guide_cache').first()).count,0);
});
