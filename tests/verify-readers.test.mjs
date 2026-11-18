import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Agent } from 'undici';
import { provision } from '../deploy/identity/accounts.mjs';
import { createIdentityServer } from '../deploy/identity/server.mjs';
import { migrate } from '../deploy/web/migrate.mjs';
import { openDatabase } from '../deploy/web/sqlite.mjs';
import { verifyReaders, verifyVisitors } from '../deploy/verify-readers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readers = ['reader-a', 'reader-b'].map(username => ({ username, password: randomUUID() }));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('checks require two distinct synthetic readers and HTTPS before sending credentials', async () => {
  const calls = { fetchImpl: () => assert.fail('unexpected network request') };
  await assert.rejects(verifyReaders({ ...calls, origin: 'http://book.example', readers }), /HTTPS/);
  await assert.rejects(verifyVisitors({ ...calls, origin: 'http://book.example' }), /HTTPS/);
  await assert.rejects(verifyReaders({ ...calls, origin: 'https://book.example', readers: [readers[0], readers[0]] }), /distinct/);
});

test('HTTPS guest and account flows isolate real SQLite state and clean up after a sandbox outage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'book-acceptance-'));
  const certFile = join(dir, 'cert.pem'), keyFile = join(dir, 'key.pem');
  let app, ingress, identity, dispatcher, db;
  const sqliteKey = Symbol.for('zero-to-ai-book.sqlite');
  const oldPath = process.env.SQLITE_PATH, oldOrigin = process.env.PUBLIC_ORIGIN;
  t.after(async () => {
    await dispatcher?.close();
    await close(ingress);
    identity?.emit('close');
    await close(app);
    db?.close();
    delete globalThis[sqliteKey];
    for (const [key, value] of [['SQLITE_PATH', oldPath], ['PUBLIC_ORIGIN', oldOrigin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  // Only the generated certificate is trusted by this client; the host trust store is untouched.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio:'ignore' });
  const cert = await readFile(certFile);
  dispatcher = new Agent({ connect: { ca: cert } });
  const signInPaths = new Set(['/signin-with-chatgpt', '/signout-with-chatgpt']);
  let accountRequests = 0;
  ingress = https.createServer({ cert, key: await readFile(keyFile) }, (req, res) => {
    if (signInPaths.has(req.url.split('?')[0])) accountRequests++;
    identity.emit('request', req, res);
  });
  const origin = 'https://127.0.0.1:' + await listen(ingress);
  process.env.PUBLIC_ORIGIN = origin;
  process.env.SQLITE_PATH = join(dir, 'learning.sqlite');
  db = openDatabase(process.env.SQLITE_PATH);
  migrate(db, join(root, 'drizzle'));
  const stateBundle = join(dir, 'state.mjs');
  await build({ absWorkingDir: root, entryPoints: ['app/api/state/route.ts'], bundle:true, platform:'node', format:'esm',
    alias:{ 'cloudflare:workers':'./deploy/web/node-env.mjs' }, outfile: stateBundle });
  const stateRoute = await import(pathToFileURL(stateBundle));
  const accountDir = join(dir, 'accounts');
  const saved = [];
  for (const [i, reader] of readers.entries()) {
    const id = await provision(accountDir, reader.username, reader.password, false);
    const state = i === 0 ? { predictions: { keep: 'existing choice' }, fontSize: 18 } : { reduceMotion:true };
    db.prepare('INSERT INTO learning_state (user_id,state,revision,updated_at) VALUES (?,?,1,0)').run(id, JSON.stringify(state));
    saved.push({ id, state });
  }
  const sandboxActions = [];
  let failExecution = false;
  app = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    if (req.url === '/api/runtime') {
      const { action } = JSON.parse(Buffer.concat(chunks));
      sandboxActions.push(action);
      if (failExecution && (action === 'status' || action === 'reset')) {
        res.writeHead(200, { 'content-type':'application/json' }).end(JSON.stringify({ exists:false, runtime:'gvisor' }));
      } else res.writeHead(503).end();
      return;
    }
    if (new URL(req.url, origin).pathname !== '/api/state') { res.writeHead(404).end(); return; }
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const reply = await stateRoute[req.method](request);
    res.writeHead(reply.status, Object.fromEntries(reply.headers)).end(await reply.text());
  });
  identity = await createIdentityServer({ publicOrigin:origin, directory:accountDir, upstream:'http://127.0.0.1:' + await listen(app) });
  const messages = [];
  const options = { readers, origin, fetchImpl:(url, args) => fetch(url, { ...args, dispatcher }), report:line => messages.push(line) };
  const assertClean = async () => {
    assert.deepEqual(await readdir(join(accountDir, 'sessions')), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM learning_state').get().n, saved.length);
    for (const entry of saved) {
      const row = db.prepare('SELECT state FROM learning_state WHERE user_id=?').get(entry.id);
      assert.deepEqual(JSON.parse(row.state), entry.state);
    }
  };
  await verifyReaders(options);
  await assertClean();
  assert.deepEqual(sandboxActions, []);
  await assert.rejects(verifyReaders({ ...options, sandbox:true }), /sandbox status failed \(HTTP 503\)/);
  await assertClean();
  assert.deepEqual(sandboxActions, ['status']);
  const accountRequestsBefore = accountRequests;
  assert.ok(accountRequestsBefore > 0);
  const guestOptions = { origin, fetchImpl: options.fetchImpl, report: options.report };
  await verifyVisitors(guestOptions);
  await assertClean();
  failExecution = true;
  await assert.rejects(verifyVisitors({ ...guestOptions, sandbox:true }), /sandbox execute failed \(HTTP 503\)/);
  await assertClean();
  assert.deepEqual(sandboxActions, ['status', 'status', 'execute', 'reset', 'status']);
  assert.equal(accountRequests, accountRequestsBefore, 'Guest verification touched a login/logout endpoint');
  assert.ok(messages.every(line => readers.every(r => !line.includes(r.username) && !line.includes(r.password))));
});
