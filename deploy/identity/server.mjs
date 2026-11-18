import http from 'node:http';
import { opendir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeDirectory, openSession, readSession, sessionKey, sessionLifetime, validName, validPassword, verifyLogin } from './accounts.mjs';

const login = '/signin-with-chatgpt';
const logout = '/signout-with-chatgpt';
const cookieName = '__Host-book_session';
const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const authHeaders = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };
const hopByHop = 'connection keep-alive proxy-connection proxy-authenticate proxy-authorization te trailer transfer-encoding upgrade'.split(' ');

// The web app consumes gateway identity headers. It has no server-side browser cookies.
// Keep browser navigation, media/conditional requests, and documented Next client inputs.
const requestHeaders = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'pragma', 'user-agent',
  'content-type', 'content-length', 'content-encoding', 'range', 'if-range', 'if-match',
  'if-none-match', 'if-modified-since', 'if-unmodified-since', 'origin',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'rsc', 'next-url', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch',
  'x-learning-scope',
]);

function publicAsset(method, pathname) {
  return (method === 'GET' || method === 'HEAD') && (pathname === '/favicon.svg'
    || ['/assets/', '/course/', '/media/', '/runtime/', '/_next/static/'].some(prefix => pathname.startsWith(prefix)));
}


function safeReturn(input, origin) {
  if (!input?.startsWith('/') || input.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(input)) return '/';
  const url = new URL(input, origin);
  if (url.origin !== origin || url.pathname.startsWith('//') || [login, logout, '/callback'].includes(url.pathname)) return '/';
  return url.pathname + url.search + url.hash;
}
const escape = (text) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function form(signIn, next, message = '') {
  const title = signIn ? '读者登录' : '退出登录';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 从零开始学 AI</title><style>*{box-sizing:border-box}body{margin:12vh auto;padding:0 1.4rem;max-width:27rem;color:#343c31;background:#f7f3e9;font:1rem/1.65 system-ui,sans-serif}h1{font-family:serif}label,input,button{display:block;width:100%}input,button{font:inherit;padding:.6rem;margin:.2rem 0 1rem}button{background:#41573e;color:white;border:0;border-radius:.25rem;cursor:pointer}a{color:#41573e}</style>
<main><h1>${title}</h1>${message ? '<p role="alert">' + escape(message) + '</p>' : ''}<form method="post" action="${signIn ? login : logout}">
<input type="hidden" name="return_to" value="${escape(next)}">
${signIn ? '<label>读者账号<input autofocus required name="username" maxlength="40" autocomplete="username"></label><label>密码<input required type="password" name="password" autocomplete="current-password"></label>' : '<p>退出后，仍可继续阅读。</p>'}
<button>${title}</button></form><a href="${escape(next)}">返回阅读</a></main></html>`;
}

function send(res, status, body = '', extra = {}) {
  res.writeHead(status, { ...authHeaders, 'content-type': 'text/html; charset=utf-8', ...extra });
  res.end(body);
}

async function readForm(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return { status: 415 };
  if (Number(req.headers['content-length']) > 4096) return { status: 413 };
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) { req.resume(); return { status: 413 }; }
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return { fields };
}

function cookieParts(req) {
  return (req.headers.cookie || '').split(';').map(c => c.trim()).filter(Boolean);
}
function sessionToken(req) {
  const matches = cookieParts(req).filter(c => c.split('=', 1)[0] === cookieName);
  return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : null;
}

function forward(req, res, upstream, origin, user, asset) {
  const blocked = new Set((req.headers.connection || '').toLowerCase().split(',').map(s => s.trim()));
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!blocked.has(name) && requestHeaders.has(name)) headers[name] = value;
  }
  if (req.method === 'POST' && headers.origin === origin.origin && !blocked.has('next-action') && req.headers['next-action']) {
    headers['next-action'] = req.headers['next-action'];
  }
  headers.host = origin.host;
  headers['x-forwarded-host'] = origin.host;
  headers['x-forwarded-proto'] = origin.protocol.slice(0, -1);
  headers['x-forwarded-port'] = origin.port || '443';
  if (user) {
    headers['oai-authenticated-user-id'] = user.id;
    headers['oai-authenticated-user-email'] = user.name + '@reader.invalid';
    headers['oai-authenticated-user-full-name'] = user.name;
    headers['oai-authenticated-user-full-name-encoding'] = 'percent-encoded-utf-8';
  }
  const outbound = http.request(upstream, { path: req.url, method: req.method, headers }, incoming => {
    const denied = new Set([...hopByHop, 'set-cookie', ...(incoming.headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
    const outgoing = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !denied.has(key)));
    if (!asset || (incoming.statusCode >= 300 && incoming.statusCode !== 304)) {
      // Private pages, redirects and API/guide streams must stay out of shared caches.
      for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'vercel-cdn-cache-control', 'surrogate-control', 'expires']) delete outgoing[name];
      outgoing['cache-control'] = /\bno-transform\b/i.test(outgoing['cache-control'] || '') ? 'private, no-store, no-transform' : 'private, no-store';
      const vary = (outgoing.vary || '').split(',').map(name => name.trim()).filter(Boolean);
      if (!vary.includes('*') && !vary.some(name => name.toLowerCase() === 'cookie')) vary.push('Cookie');
      outgoing.vary = vary.join(', ');
    }
    res.writeHead(incoming.statusCode, outgoing);
    incoming.on('error', () => res.destroy());
    incoming.pipe(res);
  });
  outbound.on('error', () => res.headersSent ? res.destroy() : send(res, 502, '阅读服务暂时未响应。'));
  res.on('close', () => { if (!res.writableFinished) outbound.destroy(); });
  req.on('error', () => outbound.destroy());
  req.pipe(outbound);
}

async function expireSessions(directory) {
  const files = await opendir(join(directory, 'sessions'));
  const cutoff = Date.now() - sessionLifetime * 1000;
  for await (const file of files) {
    if (!file.isFile() || !/^[0-9a-f]{48}$/.test(file.name)) continue;
    const path = join(directory, 'sessions', file.name);
    try { if ((await stat(path)).mtimeMs <= cutoff) await unlink(path); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export async function createIdentityServer({ publicOrigin, upstream = 'http://web:3000', directory = '/var/lib/book-identity' }) {
  const origin = new URL(publicOrigin);
  const target = new URL(upstream);
  if (origin.origin !== publicOrigin || origin.protocol !== 'https:') throw Error('BOOK_PUBLIC_ORIGIN must be a canonical https origin without a trailing slash');
  if (target.protocol !== 'http:' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw Error('BOOK_WEB_UPSTREAM must be an internal HTTP origin');
  await initializeDirectory(directory);
  const key = await sessionKey(directory);
  const attempts = new Map();
  let total = 0, running = 0, nextWindow = 0;
  // Limit guesses without trusting a client-supplied IP behind the shared TLS proxy.
  function allowAttempt(name) {
    if (Date.now() >= nextWindow) { attempts.clear(); total = 0; nextWindow = Date.now() + 60000; }
    if (running >= 2 || total >= 48 || (attempts.get(name) || 0) >= 8) return false;
    attempts.set(name, (attempts.get(name) || 0) + 1);
    total++;
    return true;
  }
  async function handle(req, res) {
    if (req.headers.host?.toLowerCase() !== origin.host || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return send(res, 400);
    const url = new URL(req.url, origin);
    const auth = [login, logout].includes(url.pathname);
    const unsafe = !['GET','HEAD','OPTIONS'].includes(req.method);
    if ((auth || unsafe) && ((req.headers.origin && req.headers.origin !== origin.origin) || req.headers['sec-fetch-site'] === 'cross-site')) return send(res, 403);
    if (!auth) {
      const asset = publicAsset(req.method, url.pathname);
      const user = asset ? null : await readSession(directory, key, sessionToken(req));
      return forward(req, res, target, origin, user, asset);
    }
    const signIn = url.pathname === login;
    if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, form(signIn, safeReturn(url.searchParams.get('return_to'), origin.origin)));
    if (req.method !== 'POST') return send(res, 405, '', { allow: 'GET, HEAD, POST' });
    if (req.headers.origin !== origin.origin) return send(res, 403);
    const { fields, status } = await readForm(req);
    if (!fields) return send(res, status);
    const next = safeReturn(fields.get('return_to') ?? url.searchParams.get('return_to'), origin.origin);
    if (!signIn) {
      const user = await readSession(directory, key, sessionToken(req));
      if (user) await unlink(user.path).catch(err => { if (err.code !== 'ENOENT') throw err; });
      return send(res, 303, '', { location: next, 'set-cookie': cookie('', 0) });
    }
    const name = fields.get('username'), password = fields.get('password') || '';
    if (!validName(name) || !validPassword(password)) return send(res, 401, form(true, next, '账号或密码有误。'));
    if (!allowAttempt(name)) return send(res, 429, form(true, next, '尝试次数较多，请稍后再试。'), { 'retry-after': '60' });
    running++;
    let user;
    try { user = await verifyLogin(directory, name, password); } finally { running--; }
    if (!user) return send(res, 401, form(true, next, '账号或密码有误。'));
    return send(res, 303, '', { location: next, 'set-cookie': cookie(await openSession(directory, key, user), sessionLifetime) });
  }
  const server = http.createServer({ requestTimeout: 120000, headersTimeout: 15000, maxHeaderSize: 16384 }, (req, res) => {
    handle(req, res).catch(() => { if (res.headersSent) res.destroy(); else send(res, 500, '读者服务暂时未响应。'); });
  });
  const cleanup = setInterval(() => expireSessions(directory).catch(err => console.error('Session cleanup:', err.code)), 3600000);
  cleanup.unref();
  server.once('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = await createIdentityServer({ publicOrigin: process.env.BOOK_PUBLIC_ORIGIN, upstream: process.env.BOOK_WEB_UPSTREAM, directory: process.env.BOOK_IDENTITY_DIR });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
}
