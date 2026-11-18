import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIdentityServer } from './server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const close = (server) => new Promise(resolve => server.close(resolve));
const origin = 'https://reading.example';
function request(port, path, { body, cookie, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      host: 'reading.example', ...(body === undefined ? {} : { origin, 'content-type': 'application/x-www-form-urlencoded' }),
      ...(cookie ? { cookie } : {}), ...headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.once('error', reject);
    req.end(body);
  });
}
async function provision(dir, username, password, reset = false) {
  const script = fileURLToPath(new URL('./provision.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, ...(reset ? ['--reset'] : []), username],
    { stdio: ['pipe','pipe','pipe'], env: { ...process.env, BOOK_IDENTITY_DIR: dir } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const done = once(child, 'exit');
  child.stdin.end(password + '\n');
  const [code] = await done;
  assert.equal(code, 0, output);
  return output.trim().split(' · ').at(-1);
}

test('self-hosted reader identity, revocation, password reset and ingress boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'book-readers-'));
  let finishStream;
  const app = http.createServer((req,res) => {
    res.setHeader('cache-control', 'public, s-maxage=600, no-transform');
    res.setHeader('cdn-cache-control', 'public, max-age=600');
    res.setHeader('set-cookie', '__Host-book_session=from-upstream; Secure; Path=/');
    res.setHeader('vary', 'RSC');
    res.setHeader('connection', 'close, internal-hop');
    res.setHeader('internal-hop', 'discard');
    if (req.url === '/media/sample.mp4' && req.headers.range === 'bytes=0-1') {
      assert.equal(req.headers['oai-authenticated-user-id'], undefined);
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/10', 'accept-ranges': 'bytes' });
      return res.end('ab');
    }
    if (req.url === '/api/guide?stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      finishStream = () => res.end('data: last\n\n');
      return;
    }
    if (req.url === '/api/guide') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setImmediate(() => res.end('data: last\n\n'));
      return;
    }
    if (req.url === '/redirect') res.writeHead(302, { location: '/' });
    res.end(JSON.stringify(req.headers));
  });
  const upstream = 'http://127.0.0.1:' + await listen(app);
  let proxy;
  t.after(async () => { if (proxy?.listening) await close(proxy); await close(app); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    proxy = await createIdentityServer({ publicOrigin: origin, upstream, directory });
    return listen(proxy);
  };
  let port = await start();
  const alicePass = randomBytes(32).toString('hex'), bobPass = randomBytes(32).toString('hex');
  const alice = await provision(directory, 'reader-a', alicePass), bob = await provision(directory, 'reader-b', bobPass);
  assert.notEqual(alice, bob);
  assert.equal((await stat(join(directory, 'session-key'))).mode & 0o777, 0o600);
  const storedUser = await readFile(join(directory, 'users/reader-a.json'), 'utf8');
  assert.ok(!storedUser.includes(alicePass));
  assert.match(JSON.parse(storedUser).hash, /^[a-f0-9]{128}$/);
  const signIn = (username, password, return_to = '/') => request(port, '/signin-with-chatgpt', {
    body: new URLSearchParams({ username, password, return_to }).toString(),
  });
  const enter = async (name, pass, next = '/') => {
    const reply = await signIn(name, pass, next); assert.equal(reply.status, 303);
    const [set] = reply.headers['set-cookie'];
    for (const attr of ['__Host-book_session=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']) assert.ok(set.includes(attr));
    return { token: set.split(';')[0], location: reply.headers.location };
  };
  const spoof = { 'oai-authenticated-user-email': 'untrusted', 'oai-authenticated-user-id': 'untrusted',
    'x-forwarded-proto': 'http', 'x-forwarded-host': 'spoof.invalid', 'x-forwarded-for': 'untrusted',
    'forwarded': 'host=spoof.invalid', 'x-real-ip': 'untrusted', 'cf-connecting-ip': 'untrusted',
    'x-learning-scope': 'preserved', 'connection': 'close, accept-language', 'accept-language': 'nominated hop header',
    'authorization': 'Bearer synthetic-test-value', 'proxy-authorization': 'Basic synthetic-test-value',
    'x-middleware-private': 'untrusted', 'x-matched-path': 'untrusted', 'x-invoke-test': 'untrusted',
    'x-now-route-matches': 'untrusted', 'internal-routing-header': 'untrusted', 'next-action': 'ignored on GET',
    'rsc': '1', 'next-router-state-tree': 'tree', 'next-router-prefetch': '1', 'next-router-segment-prefetch': '/page',
    'next-url': '/book', 'if-none-match': '"asset"', accept: 'text/x-component' };
  const echo = async (cookie) => JSON.parse((await request(port, '/', { cookie, headers: spoof })).text);
  const anonymous = await echo();
  assert.equal(anonymous.host, 'reading.example'); assert.equal(anonymous['x-forwarded-proto'], 'https');
  assert.equal(anonymous['x-forwarded-host'], 'reading.example'); assert.equal(anonymous['x-learning-scope'], 'preserved');
  for (const h of ['oai-authenticated-user-id','oai-authenticated-user-email','x-forwarded-for','forwarded','x-real-ip',
    'cf-connecting-ip','accept-language','authorization','proxy-authorization','x-middleware-private','x-matched-path',
    'x-invoke-test','x-now-route-matches','internal-routing-header','next-action','cookie']) assert.equal(anonymous[h], undefined, h);
  for (const h of ['rsc','next-router-state-tree','next-router-prefetch','next-router-segment-prefetch','next-url','if-none-match','accept']) assert.equal(anonymous[h], spoof[h], h);
  const actions = await request(port, '/', { body:'', headers:{ 'next-action':'client-action' } });
  assert.equal(JSON.parse(actions.text)['next-action'], 'client-action');
  assert.equal((await request(port, '/', { headers: { host: 'spoof.invalid' } })).status, 400);
  const form = await request(port, '/signin-with-chatgpt?return_to=%2Fchapter');
  assert.match(form.text, /name="username"/); assert.match(form.text, /value="\/chapter"/);
  for (const headers of [{ origin:'https://foreign.example' }, { origin:'' }, { 'sec-fetch-site':'cross-site' }]) {
    assert.equal((await request(port, '/signin-with-chatgpt', { body:'', headers })).status, 403);
  }
  assert.equal((await request(port, '/signin-with-chatgpt', { body:'x'.repeat(4200) })).status, 413);
  assert.equal((await signIn('reader-a', bobPass)).status, 401);
  const first = await enter('reader-a', alicePass, '/?chapter=intro#example');
  assert.equal(first.location, '/?chapter=intro#example');
  const second = await enter('reader-b', bobPass, '/.//foreign.example');
  assert.equal(second.location, '/');
  let passed = await echo(first.token + '; unrelated_account=synthetic; upstream_session=synthetic');
  assert.equal(passed['oai-authenticated-user-id'], alice); assert.equal(passed.cookie, undefined);
  const asset = await request(port, '/media/sample.mp4', { cookie: first.token, headers: { range:'bytes=0-1' } });
  assert.equal(asset.status, 206); assert.equal(asset.text, 'ab'); assert.equal(asset.headers['content-range'], 'bytes 0-1/10');
  assert.equal(asset.headers['cache-control'], 'public, s-maxage=600, no-transform');
  assert.equal(asset.headers['set-cookie'], undefined); assert.equal(asset.headers['internal-hop'], undefined);
  for (const endpoint of ['/', '/api/state', '/redirect', '/api/guide']) {
    const response = await request(port, endpoint, { cookie:first.token });
    assert.equal(response.headers['cache-control'], 'private, no-store, no-transform', endpoint);
    assert.equal(response.headers.vary, 'RSC, Cookie');
    assert.equal(response.headers['set-cookie'], undefined); assert.equal(response.headers['cdn-cache-control'], undefined);
    if (endpoint === '/api/guide') {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      assert.equal(response.text, 'data: first\n\ndata: last\n\n');
    }
  }
  // Release the final event only when the client has already received the first event.
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname:'127.0.0.1', port, path:'/api/guide?stream',
      headers:{ host:'reading.example', accept:'text/event-stream', cookie:first.token } }, res => {
      res.setEncoding('utf8');
      let firstChunk = true, body = '';
      res.on('data', data => {
        body += data;
        if (firstChunk) { firstChunk = false; finishStream(); }
      });
      res.on('end', () => { clearTimeout(timeout); resolve(body); });
      res.on('error', reject);
    });
    const timeout = setTimeout(() => {
      finishStream?.(); req.destroy(); reject(Error('Gateway buffered the event stream'));
    }, 5000);
    req.on('error', err => { clearTimeout(timeout); reject(err); });
  }).then(body => assert.equal(body, 'data: first\n\ndata: last\n\n'));
  assert.equal(passed['oai-authenticated-user-email'], 'reader-a@reader.invalid');
  assert.equal((await echo(second.token))['oai-authenticated-user-id'], bob);
  assert.equal((await echo(first.token + 'x'))['oai-authenticated-user-id'], undefined);
  assert.equal((await echo(first.token + '; ' + second.token))['oai-authenticated-user-id'], undefined);
  await close(proxy); port = await start();
  assert.equal((await echo(first.token))['oai-authenticated-user-id'], alice);
  assert.match((await request(port, '/signout-with-chatgpt', { cookie:first.token })).text, /method="post"/);
  assert.equal((await request(port, '/signout-with-chatgpt', { body:'', cookie:first.token, headers:{origin:'https://foreign.example'} })).status, 403);
  assert.equal((await echo(first.token))['oai-authenticated-user-id'], alice);
  const signout = await request(port, '/signout-with-chatgpt', { body:'return_to=%2Fchapter', cookie:first.token });
  assert.equal(signout.status, 303); assert.equal(signout.headers.location, '/chapter'); assert.match(signout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await echo(first.token))['oai-authenticated-user-id'], undefined);
  const newPassword = randomBytes(32).toString('hex');
  assert.equal(await provision(directory, 'reader-b', newPassword, true), bob);
  assert.equal((await echo(second.token))['oai-authenticated-user-id'], undefined);
  assert.equal((await signIn('reader-b', bobPass)).status, 401);
  passed = await echo((await enter('reader-b', newPassword)).token);
  assert.equal(passed['oai-authenticated-user-id'], bob);
  for (let i = 0; i < 8; i++) assert.equal((await signIn('unknown-reader', bobPass)).status, 401);
  assert.equal((await signIn('unknown-reader', bobPass)).status, 429);
});
