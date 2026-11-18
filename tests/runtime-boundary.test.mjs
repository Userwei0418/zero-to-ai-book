import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse } from 'miniflare';

const compiled = await build({
  stdin: { contents: [
    "import { POST as runtime } from './app/api/runtime/route.ts';",
    "import { POST as guide } from './app/api/guide/route.ts';",
    "import { GET as state } from './app/api/state/route.ts';",
    "export default {fetch(req) { const path = new URL(req.url).pathname; return path === '/guide' ? guide(req) : path === '/state' ? state(req) : runtime(req); }}",
  ].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['cloudflare:workers'], tsconfig: 'tsconfig.json',
});
const readerScope = id => createHash('sha256').update(id).digest('hex').slice(0,32);
const testKey = 'fixture-key-for-test-gateway-only';

async function setup(t, options = {}) {
  const received = [];
  const mf = new Miniflare({
    script: compiled.outputFiles[0].text, modules: true, compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { SANDBOX_API_URL: 'http://sandbox-gateway:8090', SANDBOX_API_KEY: testKey,
      SELF_HOSTED_SANDBOX: '1', ...options.bindings },
    outboundService: async req => {
      received.push({ url: req.url, body: await req.json() });
      return new WorkerResponse(JSON.stringify({ status: 'idle' }), { status: options.status ?? 200 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE request_quota (key TEXT PRIMARY KEY, count INTEGER, expires_at INTEGER)');
  const send = (id, edits = {}) => mf.dispatchFetch('https://book.test/runtime', {
    method: 'POST', headers: { origin: 'https://book.test', 'content-type':'application/json',
      ...(id ? {'oai-authenticated-user-id':id} : {}) },
    body: JSON.stringify({ action:'status', chapterId:'upper-01', cacheScope: id && readerScope(id), ...edits }),
  });
  return { mf, send, received };
}

test('accounts get independent remote keys; control actions match the gateway contract', async t => {
  const { send, received } = await setup(t);
  for (const action of ['execute', 'status', 'interrupt', 'reset']) {
    const r = await send('reader-a', {action, code:'print(1)', cellId:'demo', files:{}, sessionKey:'unused-client-value'});
    assert.equal(r.status, 200);
  }
  assert.equal((await send('reader-b')).status, 200);
  const expected = createHmac('sha256', testKey).update('reader-a').digest('hex');
  assert.equal(received[0].body.sessionKey, expected);
  assert.equal(received[0].body.code, 'print(1)');
  for (const req of received.slice(1,4)) {
    assert.deepEqual(req.body, {sessionKey:expected, chapterId:'upper-01'});
  }
  assert.notEqual(received[4].body.sessionKey, expected);
  assert.equal((await send(null)).status, 401);
  assert.equal((await send('reader-b', {cacheScope:readerScope('reader-a')})).status, 409);
  assert.equal((await send('reader-a', {action:'execute',code:'例'.repeat(22000),cellId:'demo'})).status, 400);
  assert.equal(received.length, 5);
});

test('plaintext gateway is allowed only at the designated, opted-in service', async t => {
  for (const bindings of [
    { SELF_HOSTED_SANDBOX:'0' }, { SANDBOX_API_URL:'http://other-service:8090' },
    { SANDBOX_API_URL:'http://sandbox-gateway:8090/other' },
  ]) {
    const {send,received} = await setup(t, { bindings });
    assert.equal((await send('reader')).status, 503);
    assert.equal(received.length, 0);
  }
});

test('reader sees the upstream capacity status', async t => {
  const {send} = await setup(t, {status:429});
  assert.equal((await send('reader')).status,429);
});

test('identity check and stale guide request use the current account before touching data or a model', async t => {
  const {mf,received}=await setup(t);
  for (const id of [null, 'reader-a', 'reader-b']) {
    const result=await mf.dispatchFetch('https://book.test/state?identity=1',{headers:id?{'oai-authenticated-user-id':id}:{}});
    assert.deepEqual(await result.json(),{authenticated:!!id,cacheScope:id?readerScope(id):'anonymous'});
  }
  for (const action of ['ask','cancel']) {
    const result=await mf.dispatchFetch('https://book.test/guide',{method:'POST',
      headers:{origin:'https://book.test','content-type':'application/json','oai-authenticated-user-id':'reader-b','x-learning-scope':readerScope('reader-a')},
      body:JSON.stringify({action})});
    assert.equal(result.status,409);
    assert.equal((await result.json()).code,'identity_changed');
  }
  assert.equal(received.length,0);
});
