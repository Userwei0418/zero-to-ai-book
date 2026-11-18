// Run the self-hosted routes with their production Node adapter and SQLite binding.
// Only the two external HTTP services are replaced with local responses.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { d1Binding, openDatabase } from '../deploy/web/sqlite.mjs';
import { migrate } from '../deploy/web/migrate.mjs';

const origin = 'https://book.test';
const bundle = await build({
  stdin: { contents: [
    "export * as state from './app/api/state/route.ts';",
    "export * as guide from './app/api/guide/route.ts';",
    "export * as runtime from './app/api/runtime/route.ts';",
    "export * as health from './app/api/health/route.ts';",
  ].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
  alias: { 'cloudflare:workers': './deploy/web/node-env.mjs' },
  define: { 'process.env': JSON.stringify({
    PUBLIC_ORIGIN: origin, TOKENPLAN_API_KEY: 'fixture-guide', SANDBOX_API_URL: 'https://gateway.test',
    SANDBOX_API_KEY: 'fixture-gateway', GUEST_AI_DAILY_LIMIT: '2', GUEST_AI_SITE_DAILY_LIMIT: '3',
    GUEST_RUNTIME_SITE_DAILY_LIMIT: '1',
  }) },
  bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'tsconfig.json',
});
const routes = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const guest = char => 'guest:' + char.repeat(48);
const alice = guest('a'), bob = guest('b');
const scope = id => createHash('sha256').update(id).digest('hex').slice(0, 32);
function setup(t) {
  const db = openDatabase(':memory:');
  migrate(db, 'drizzle');
  const databaseKey = Symbol.for('zero-to-ai-book.sqlite');
  globalThis[databaseKey] = d1Binding(db);
  t.after(() => { delete globalThis[databaseKey]; db.close(); });
  return db;
}
function send(route, method, id, body, options = {}) {
  const headers = { origin, 'content-type': 'application/json', ...options.headers };
  if (id) headers[id.startsWith('guest:') ? 'x-book-guest-id' : 'oai-authenticated-user-id'] = id;
  const request = new Request(origin + '/api/' + route + (options.query || ''), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return routes[route][method](request);
}
const guide = (id, question, options = {}) => send('guide', 'POST', id,
  { chapterId: 'upper-intro', question, ...options.body },
  { headers: { 'x-learning-scope': scope(id), ...options.headers } });
const modelReply = () => Response.json({ choices: [{ message: { content: '课程回答。' } }] });

test('private guest, account and anonymous scopes and state ownership', async t => {
  setup(t);
  const get = (id, options) => send('state', 'GET', id, undefined, options);
  const identity = await (await get(alice, {query: '?identity=1'})).json();
  assert.deepEqual(identity, {authenticated:false, recognized:true, identityKind:'guest', cacheScope:scope(alice)});
  assert.equal((await (await get('guest:invalid')).json()).recognized, false);
  const account = await (await get('account-1', {headers:{'x-book-guest-id':alice}})).json();
  assert.deepEqual([account.identityKind, account.authenticated, account.cacheScope], ['account', true, scope('account-1')]);
  const body = { revision:0, cacheScope:scope(alice), state:{anchor:'alice-page'}, userId:alice };
  assert.equal((await send('state', 'PUT', bob, body)).status, 409);
  assert.equal((await send('state', 'PUT', null, body)).status, 401);
  assert.equal((await send('state', 'PUT', alice, body, {headers:{origin:'https://unrelated.test'}})).status, 403);
  assert.equal((await send('state', 'PUT', alice, body)).status, 200);
  assert.deepEqual((await (await get(bob)).json()).state, {});
  assert.equal((await send('state', 'DELETE', bob, undefined, {headers:{'x-learning-scope':scope(alice)}})).status, 409);
  assert.equal((await (await get(alice)).json()).state.anchor, 'alice-page');
  assert.equal((await send('state', 'DELETE', alice, undefined, {headers:{'x-learning-scope':scope(alice)}})).status, 200);
  assert.deepEqual((await (await get(alice)).json()).state, {});
});

test('guest guide admission is atomic per reader and across new guests; cached results remain readable', async t => {
  const db = setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return modelReply(); });
  const simultaneous = await Promise.all([1,2,3,4].map(i => guide(alice, '甲' + i)));
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200,200,429,429]);
  const cachedQuestion = '甲' + (simultaneous.findIndex(r => r.status === 200) + 1);
  assert.equal((await (await guide(alice, cachedQuestion)).json()).cached, true);
  const rotated = await Promise.all([bob,guest('c'),guest('d'),guest('e')].map(id => guide(id, cachedQuestion)));
  assert.deepEqual(rotated.map(r => r.status).sort(), [200,429,429,429]);
  assert.equal(calls, 3);
  assert.equal(db.prepare("SELECT count(*) n FROM request_quota WHERE key LIKE 'guide-pending:%'").get().n, 0);
  assert.equal((await guide('account-1', cachedQuestion)).status, 200);
  assert.equal(calls, 4);
});

test('guest calls require the current scope for ask and stop, and a billable dispatched call stays counted', async t => {
  setup(t);
  const id = randomUUID();
  for (const body of [{chapterId:'upper-intro'}, {action:'cancel', requestId:id}]) {
    assert.equal((await send('guide', 'POST', alice, body)).status, 409);
    assert.equal((await send('guide', 'POST', bob, body, {headers:{'x-learning-scope':scope(alice)}})).status, 409);
  }
  let started, finish, calls = 0;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) { started(); await gate; }
    return modelReply();
  });
  const first = guide(alice, '已发送', {body:{requestId:id}});
  await began;
  assert.equal((await guide(alice, '', {body:{action:'cancel', requestId:id}})).status, 200);
  finish();
  assert.notEqual((await first).status, 200);
  assert.equal((await guide(alice, '下一问')).status, 200);
  assert.equal((await guide(alice, '第三问')).status, 429);
  assert.equal(calls, 2);
});

test('guest remote dispatch budget survives identity changes and leaves control actions available', async t => {
  setup(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({url, body:JSON.parse(init.body)});
    return Response.json({status:'idle'});
  });
  const runtime = (id, action, edits = {}) => send('runtime', 'POST', id, { action, chapterId:'upper-01', cellId:'demo',
    code:'print(1)', cacheScope:scope(id), sessionKey:'untrusted', ...edits });
  assert.equal((await runtime(bob, 'execute', {cacheScope:scope(alice)})).status, 409);
  const output = await Promise.all([alice,bob].map(id => runtime(id, 'execute')));
  assert.deepEqual(output.map(r => r.status).sort(), [200,429]);
  for (const id of [alice,bob]) {
    for (const action of ['status','reset','interrupt']) assert.equal((await runtime(id, action)).status, 200);
  }
  assert.notEqual(requests[1].body.sessionKey, requests[4].body.sessionKey);
  assert.notEqual(requests[1].body.sessionKey, 'untrusted');
  assert.equal((await runtime('account-1', 'execute')).status, 200);
  const diagnostic = await (await send('health','GET',alice,undefined,{query:'?checkAI=1'})).json();
  assert.equal(diagnostic.authenticated, false);
  assert.equal(diagnostic.modelCheck, undefined);
  assert.equal(requests.length, 8);
});
