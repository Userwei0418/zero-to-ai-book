import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const signIn = '/signin-with-chatgpt';
const signOut = '/signout-with-chatgpt';
const cookieName = '__Host-book_session';
const guestCookie = '__Host-book_guest';
class CheckFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

async function json(reply, label) {
  try { return await reply.json(); }
  catch { throw new CheckFailure(label + ' returned invalid JSON'); }
}

function validateOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new CheckFailure('Set BOOK_PUBLIC_ORIGIN to the canonical public HTTPS origin'); }
  check(parsed.protocol === 'https:' && origin === parsed.origin, 'BOOK_PUBLIC_ORIGIN must be a canonical HTTPS origin with no path or credentials');
}

function client(origin, fetchImpl, cookies = new Map()) {
  async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', 'BookReaderVerification/1.0');
    headers.set('sec-fetch-site', 'same-origin');
    if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => name + '=' + value).join('; '));
    if (options.method) headers.set('origin', origin);
    try {
      const reply = await fetchImpl(origin + path, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(110000) });
      // Browsers retain both the guest cookie and an optional signed-in reader cookie.
      for (const line of reply.headers.getSetCookie()) {
        const match = line.match(/^(__Host-book_[A-Za-z0-9_-]+)=([^;]*)/);
        if (!match) continue;
        if (!match[2] || /;\s*max-age=0(?:;|$)/i.test(line)) cookies.delete(match[1]);
        else cookies.set(match[1], match[2]);
      }
      return reply;
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
    check(reply.status === 303 && reply.headers.get('location') === '/', 'Login/logout form submission failed (HTTP ' + reply.status + ')');
    const flags = (line || '').split(';').slice(1).map(item => item.trim().toLowerCase());
    check(flags.includes('secure') && flags.includes('httponly') && flags.includes('path=/') && flags.includes('samesite=lax'), 'Session cookie flags missing');
    if (path === signOut) {
      check(pair === cookieName + '=' && flags.includes('max-age=0'), 'Logout did not clear the session cookie');
    } else check(pair?.length > cookieName.length + 1, 'Login did not establish a session');
  }
  async function state(identityOnly = false, headers) {
    const reply = await request(identityOnly ? '/api/state?identity=1' : '/api/state', { headers });
    check(reply.ok, 'Reading learning state failed (HTTP ' + reply.status + ')');
    return json(reply, '/api/state');
  }
  async function post(path, method, body) {
    return request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return {
    login: reader => form(signIn, reader), logout: () => cookies.has(cookieName) ? form(signOut, {}) : Promise.resolve(), state, post, request,
    copy: () => client(origin, fetchImpl, new Map(cookies)), clearCookies: () => cookies.clear(),
  };
}

// Change only a unique test prediction using optimistic concurrency. On cleanup preserve
// other edits, and drop an empty predictions map only if this test introduced the map.
async function mark(account, key, value, remove = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { authenticated, identityKind, cacheScope, state, revision } = await account.http.state();
    const expectedReader = account.guest ? authenticated === false && identityKind === 'guest' : authenticated === true;
    check(expectedReader && cacheScope === account.scope, 'Reader changed before saving test state');
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
  validateOrigin(origin);
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

async function startVisitor(http) {
  // The first GET requests the cookie. Only its return on the second GET proves
  // the browser accepts cookies and can safely address a private learning scope.
  const headers = { 'x-book-visitor-bootstrap': '1' };
  const first = await http.request('/api/state?identity=1', { headers });
  check(first.ok && first.headers.get('x-book-guest-bootstrap') === '1', 'Missing first-party visitor bootstrap');
  const firstState = await json(first, '/api/state');
  check(firstState.authenticated === false && firstState.cacheScope === 'anonymous', 'Bootstrap exposed a learning scope before cookie confirmation');
  const issued = first.headers.getSetCookie().find(line => line.startsWith(guestCookie + '='));
  const flags = (issued || '').split(';').slice(1).map(item => item.trim().toLowerCase());
  check(flags.includes('secure') && flags.includes('httponly') && flags.includes('path=/') && flags.includes('samesite=lax') &&
    !flags.some(flag => flag.startsWith('domain=')), 'Visitor cookie is missing required host-only flags');
  const saved = await http.state(false, headers);
  check(saved.authenticated === false && saved.identityKind === 'guest' && /^[a-f0-9]{32}$/.test(saved.cacheScope),
    'Returning the cookie did not establish a private visitor scope');
  check(saved.revision === 0 && Object.keys(saved.state).length === 0, 'A fresh visitor inherited existing records');
  return saved.cacheScope;
}

async function removeVisitorRecord(visitor, key) {
  const snapshot = await visitor.http.state();
  check(snapshot.identityKind === 'guest' && snapshot.authenticated === false && snapshot.cacheScope === visitor.scope,
    'Refusing to clean a different visitor');
  if (snapshot.revision === 0) return;
  const { predictions, ...other } = snapshot.state;
  if (predictions?.[key] === visitor.marker && Object.keys(predictions).length === 1 && !Object.keys(other).length) {
    // Only a newly issued guest jar with this test's sole record is eligible for deletion.
    const reply = await visitor.http.request('/api/state', { method: 'DELETE', headers: { 'x-learning-scope': visitor.scope } });
    check(reply.ok && (await visitor.http.state()).revision === 0, 'Guest state cleanup failed');
  } else {
    await mark(visitor, key, visitor.marker, true);
  }
}

export async function verifyVisitors({ origin, sandbox = false, fetchImpl = fetch, report = console.log }) {
  validateOrigin(origin);
  const key = 'acceptance-' + randomUUID();
  const visitors = Array.from({ length: 2 }, () => ({ guest: true, marker: randomUUID(), http: client(origin, fetchImpl) }));
  let failure;
  try {
    for (const visitor of visitors) visitor.scope = await startVisitor(visitor.http);
    const [a, b] = visitors;
    check(a.scope !== b.scope, 'Independent guest cookies shared a learning scope');
    for (const visitor of visitors) {
      visitor.stateStarted = true;
      await mark(visitor, key, visitor.marker);
    }
    for (const visitor of visitors) {
      const saved = await visitor.http.state();
      check(saved.cacheScope === visitor.scope && saved.state.predictions?.[key] === visitor.marker,
        'Reload did not recover only the current visitor’s saved learning record');
    }
    const browserUpdate = await a.http.state(true, { 'user-agent': 'BookReaderVerification/2.0' });
    check(browserUpdate.identityKind === 'guest' && browserUpdate.cacheScope === a.scope, 'Changing the user agent lost a visitor scope');
    report('PASS · Two visitors using the same IP and browser type saved independent records without signing in.');
    if (sandbox) {
      await verifySandbox(visitors, key);
      report('PASS · Same-chapter guest Linux sessions isolated Python variables, files, execution counts and reset.');
    }
    // Retain the original test jar solely to tear down its isolated session.
    const original = a.http.copy();
    try {
      a.http.clearCookies();
      const freshScope = await startVisitor(a.http);
      check(!visitors.some(v => v.scope === freshScope), 'Clearing cookies reused a previous visitor scope');
      if (sandbox) {
        const status = await runtime({ http: a.http, scope: freshScope }, key, 'status');
        check(status.exists === false, 'A new guest could access an earlier sandbox');
      }
    } finally { a.http = original; }
    report('PASS · Clearing site cookies produced a new visitor with empty learning records.');
  } catch (error) { failure = error; }
  const cleanupFailures = [];
  for (const [i, visitor] of visitors.entries()) {
    if (visitor.sandboxStarted) {
      try {
        await runtime(visitor, key, 'reset');
        check((await runtime(visitor, key, 'status')).exists === false, 'Sandbox cleanup failed');
      } catch { cleanupFailures.push('guest ' + (i + 1) + ' sandbox'); }
    }
    if (visitor.stateStarted) {
      try { await removeVisitorRecord(visitor, key); }
      catch { cleanupFailures.push('guest ' + (i + 1) + ' state'); }
    }
  }
  if (cleanupFailures.length) throw new CheckFailure((failure instanceof CheckFailure ? failure.message + '. ' : '') +
    'Cleanup incomplete (' + cleanupFailures.join(', ') + '). Temporary test key: ' + key);
  if (failure) throw failure;
  report('PASS · Temporary guest learning records and sandbox sessions cleaned up.');
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
    check(args.every(flag => flag === '--guests' || flag === '--sandbox') && new Set(args).size === args.length,
      'Usage: node deploy/verify-readers.mjs [--guests] [--sandbox]');
    const options = { origin: process.env.BOOK_PUBLIC_ORIGIN, sandbox: args.includes('--sandbox') };
    if (args.includes('--guests')) await verifyVisitors(options);
    else await verifyReaders({ ...options, readers: await inputs(process.env) });
  } catch (error) {
    console.error(error instanceof CheckFailure ? error.message : 'Acceptance failed unexpectedly. Check service health.');
    process.exitCode = 1;
  }
}
