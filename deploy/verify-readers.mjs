import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const signIn = '/signin-with-chatgpt';
const signOut = '/signout-with-chatgpt';
const cookieName = '__Host-book_session';
class CheckFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

async function json(reply, label) {
  try { return await reply.json(); }
  catch { throw new CheckFailure(label + ' returned invalid JSON'); }
}

function client(origin, fetchImpl) {
  let cookie = '';
  async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (options.method) headers.set('origin', origin);
    try {
      return await fetchImpl(origin + path, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(110000) });
    } catch { throw new CheckFailure('Could not reach ' + path.split('?')[0] + ' before the deadline'); }
  }

  async function form(path, fields) {
    const formPage = await request(path + '?return_to=%2F');
    check(formPage.ok, 'Login/logout form returned HTTP ' + formPage.status);
    const html = await formPage.text();
    check(html.includes('action="' + path + '"') && html.includes('name="return_to"'), 'Unexpected login/logout form');
    if (path === signIn) check(html.includes('name="username"') && html.includes('name="password"'), 'Reader login fields missing');
    const reply = await request(path, { method: 'POST', body: new URLSearchParams({ ...fields, return_to: '/' }) });
    const line = reply.headers.getSetCookie().find(item => item.startsWith(cookieName + '='));
    const pair = line?.split(';')[0];
    // Keep the server-issued cookie for teardown even when a later acceptance check fails.
    if (path === signIn && pair) cookie = pair;
    check(reply.status === 303 && reply.headers.get('location') === '/', 'Login/logout form submission failed (HTTP ' + reply.status + ')');
    const flags = (line || '').split(';').slice(1).map(item => item.trim().toLowerCase());
    check(flags.includes('secure') && flags.includes('httponly') && flags.includes('path=/') && flags.includes('samesite=lax'), 'Session cookie flags missing');
    if (path === signOut) {
      check(pair === cookieName + '=' && flags.includes('max-age=0'), 'Logout did not clear the session cookie');
      cookie = '';
    } else check(pair?.length > cookieName.length + 1, 'Login did not establish a session');
  }
  async function state(identityOnly = false) {
    const reply = await request(identityOnly ? '/api/state?identity=1' : '/api/state');
    check(reply.ok, 'Reading learning state failed (HTTP ' + reply.status + ')');
    return json(reply, '/api/state');
  }
  async function post(path, method, body) {
    return request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return {
    login: reader => form(signIn, reader), logout: () => cookie ? form(signOut, {}) : Promise.resolve(), state, post,
  };
}

// Change only a unique test prediction using optimistic concurrency. On cleanup preserve
// other edits, and drop an empty predictions map only if this test introduced the map.
async function mark(account, key, value, remove = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { authenticated, cacheScope, state, revision } = await account.http.state();
    check(authenticated && cacheScope === account.scope, 'Reader changed before saving test state');
    const predictions = { ...state.predictions };
    if (remove) {
      if (predictions[key] !== value) return;
      delete predictions[key];
    } else {
      check(!Object.hasOwn(predictions, key), 'Temporary prediction key already exists or accounts share state');
      account.hadPredictions = Object.hasOwn(state, 'predictions');
    }
    if (!remove) predictions[key] = value;
    const updated = { ...state, predictions };
    if (remove && !account.hadPredictions && !Object.keys(predictions).length) delete updated.predictions;
    const reply = await account.http.post('/api/state', 'PUT', { revision, cacheScope, state: updated });
    if (reply.status === 409) continue;
    check(reply.ok, 'Saving temporary learning state failed (HTTP ' + reply.status + ')');
    return;
  }
  throw new CheckFailure('Concurrent writes prevented verification of synthetic reader state');
}

async function runtime(account, chapterId, action, code) {
  const reply = await account.http.post('/api/runtime', 'POST', { action, runtime: 'linux', cacheScope: account.scope,
    chapterId, ...(code ? { code, cellId: 'verify-' + randomUUID() } : {}) });
  check(reply.ok, 'Linux sandbox ' + action + ' failed (HTTP ' + reply.status + ')');
  const result = await json(reply, '/api/runtime');
  if (action === 'execute') check(result.status === 'ok', 'Sandbox failed to execute the test cell');
  return result;
}

async function verifySandbox(accounts, chapter) {
  const [a, b] = accounts;
  const initial = "from pathlib import Path\np = Path('reader-check.txt')\nprint('book_check' in globals(), p.exists())\n";
  const readBack = "print(book_check, p.read_text())";
  for (const account of accounts) {
    const info = await runtime(account, chapter, 'status');
    check(info.exists === false && info.runtime === 'gvisor', 'Expected a fresh gVisor session for each reader');
    account.sandboxStarted = true;
    const result = await runtime(account, chapter, 'execute', initial + 'book_check = ' + JSON.stringify(account.marker) + '\nwritten = p.write_text(book_check)\n');
    check(result.stdout.trim() === 'False False' && result.executionCount === 1, 'Fresh reader inherited variables, files or execution count');
  }
  for (const account of accounts) {
    const result = await runtime(account, chapter, 'execute', readBack);
    check(result.stdout.trim() === account.marker + ' ' + account.marker && result.executionCount === 2, 'Reader lost its own variables or files');
  }
  const reset = await runtime(a, chapter, 'reset');
  check(reset.exists === false && (await runtime(a, chapter, 'status')).exists === false, 'First reader reset did not remove the session');
  const result = await runtime(b, chapter, 'execute', readBack);
  check(result.stdout.trim() === b.marker + ' ' + b.marker && result.executionCount === 3, 'Resetting one reader affected the other');
  const fresh = await runtime(a, chapter, 'execute', initial);
  check(fresh.stdout.trim() === 'False False' && fresh.executionCount === 1, 'Reset did not clear the first reader’s variables and files');
}

export async function verifyReaders({ origin, readers, sandbox = false, fetchImpl = fetch, report = console.log }) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new CheckFailure('Set BOOK_PUBLIC_ORIGIN to the canonical public HTTPS origin'); }
  check(parsed.protocol === 'https:' && origin === parsed.origin, 'BOOK_PUBLIC_ORIGIN must be a canonical HTTPS origin with no path or credentials');
  check(Array.isArray(readers) && readers.length === 2 && readers.every(r => r && typeof r.username === 'string' &&
    /^[a-z0-9][a-z0-9_-]{2,39}$/.test(r.username) && typeof r.password === 'string' && Buffer.byteLength(r.password) >= 12 &&
    Buffer.byteLength(r.password) <= 256) && readers[0].username !== readers[1].username, 'Supply two distinct, dedicated test reader logins');
  const key = 'acceptance-' + randomUUID();
  const accounts = readers.map(reader => ({ reader: { username: reader.username, password: reader.password },
    http: client(origin, fetchImpl), marker: randomUUID() }));
  const device = client(origin, fetchImpl);
  let failure;
  try {
    const guest = await device.state(true);
    check(guest.authenticated === false && guest.cacheScope === 'anonymous', 'Fresh device unexpectedly has a reader session');
    for (const account of accounts) {
      await account.http.login(account.reader);
      const snapshot = await account.http.state(true);
      check(snapshot.authenticated === true && /^[a-f0-9]{32}$/.test(snapshot.cacheScope), 'Login did not provide an authenticated learning scope');
      account.scope = snapshot.cacheScope;
    }
    check(accounts[0].scope !== accounts[1].scope, 'Two accounts resolved to the same learning scope');
    for (const account of accounts) {
      account.stateStarted = true;
      await mark(account, key, account.marker);
    }
    // One browser cookie jar is reused, just as on a shared device. The two main
    // sessions remain available to check isolation and clean up after any failure.
    for (const account of accounts) {
      await device.login(account.reader);
      const saved = await device.state();
      check(saved.authenticated && saved.cacheScope === account.scope && saved.state.predictions?.[key] === account.marker,
        'Switching readers did not restore the correct account and its saved state');
      await device.logout();
      check((await device.state(true)).authenticated === false, 'Reader remained signed in after logout');
    }
    report('PASS · Two readers saved distinct values, recovered their own state on the same device, and signed out.');
    if (sandbox) {
      await verifySandbox(accounts, key);
      report('PASS · Two Linux sessions isolated variables, files, execution counts and reset in the same chapter.');
    }
  } catch (error) { failure = error; }
  const cleanupFailures = [];
  async function clean(label, operation) {
    try { await operation(); } catch { cleanupFailures.push(label); }
  }
  for (const [index, account] of accounts.entries()) {
    if (account.sandboxStarted) await clean('reader ' + (index + 1) + ' sandbox', async () => {
      await runtime(account, key, 'reset');
      check((await runtime(account, key, 'status')).exists === false, 'Sandbox cleanup failed');
    });
    if (account.stateStarted) await clean('reader ' + (index + 1) + ' prediction', async () => {
      await mark(account, key, account.marker, true);
      const snapshot = await account.http.state();
      check(snapshot.cacheScope === account.scope && snapshot.state.predictions?.[key] !== account.marker, 'Prediction cleanup failed');
    });
    await clean('reader ' + (index + 1) + ' logout', account.http.logout);
  }
  await clean('shared-device logout', device.logout);
  if (cleanupFailures.length) throw new CheckFailure((failure instanceof CheckFailure ? failure.message + '. ' : '') +
    'Cleanup incomplete (' + cleanupFailures.join(', ') + '). Temporary test key: ' + key);
  if (failure) throw failure;
  report('PASS · Temporary reader records and login sessions cleaned up.');
}

async function inputs(env) {
  if (['BOOK_TEST_READER_A','BOOK_TEST_PASSWORD_A','BOOK_TEST_READER_B','BOOK_TEST_PASSWORD_B'].some(name => env[name] !== undefined)) {
    return ['A', 'B'].map(id => ({ username: env['BOOK_TEST_READER_' + id], password: env['BOOK_TEST_PASSWORD_' + id] }));
  }
  check(!process.stdin.isTTY, 'Supply both dedicated test reader logins via environment variables or a JSON array on stdin');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    check(bytes <= 8192, 'Credential input too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CheckFailure('Expected a JSON array of two reader logins on stdin'); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    check(!args.length || (args.length === 1 && args[0] === '--sandbox'), 'Usage: node deploy/verify-readers.mjs [--sandbox]');
    await verifyReaders({ origin: process.env.BOOK_PUBLIC_ORIGIN, readers: await inputs(process.env), sandbox: args.length === 1 });
  } catch (error) {
    console.error(error instanceof CheckFailure ? error.message : 'Acceptance failed unexpectedly. Check service health.');
    process.exitCode = 1;
  }
}
