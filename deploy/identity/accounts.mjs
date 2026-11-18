import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { access, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const storageOptions = { mode: 0o600, flag: 'wx' };
export const sessionLifetime = 7 * 86400;
export const guestLifetime = 180 * 86400;
export const guestRenewWindow = 30 * 86400;
const hashOptions = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const notFound = (err) => err.code === 'ENOENT';
export const validName = (name) => typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{2,39}$/.test(name);
export const validPassword = (value) => Buffer.byteLength(value) >= 12 && Buffer.byteLength(value) <= 256;

export async function initializeDirectory(dir) {
  await mkdir(join(dir, 'users'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
}

// Publish only completely written files. link() gives create-only semantics across CLI processes.
async function publish(file, bytes, replace = false) {
  const temp = file + '-' + randomUUID() + '.tmp';
  await writeFile(temp, bytes, storageOptions);
  try {
    if (replace) await rename(temp, file);
    else await link(temp, file);
  } finally {
    await unlink(temp).catch(err => { if (!notFound(err)) throw err; });
  }
}

export async function sessionKey(dir) {
  const file = join(dir, 'session-key');
  let key;
  try { key = await readFile(file); }
  catch (err) {
    if (!notFound(err)) throw err;
    try { await publish(file, randomBytes(32)); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    key = await readFile(file);
  }
  if (key.length !== 32) throw Error('Invalid identity session key');
  return key;
}

async function readUser(dir, name) {
  if (!validName(name)) return null;
  try { return JSON.parse(await readFile(join(dir, 'users', name + '.json'), 'utf8')); }
  catch (err) { if (notFound(err)) return null; throw err; }
}

export async function provision(dir, name, password, reset) {
  if (!validName(name)) throw Error('账号需使用 3–40 个小写英文字母、数字、下划线或连字符，首字符为字母或数字。');
  if (!validPassword(password)) throw Error('密码长度需为 12–256 个 UTF-8 字节。');
  await initializeDirectory(dir);
  const old = await readUser(dir, name);
  if (reset && !old) throw Error('账号不存在。');
  if (!reset && old) throw Error('账号已存在。需要改密时使用 --reset。');
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 64, hashOptions);
  const user = { name, id: old?.id ?? randomUUID(), revision: randomUUID(),
    salt: salt.toString('hex'), hash: hash.toString('hex') };
  await publish(join(dir, 'users', name + '.json'), JSON.stringify(user) + '\n', reset);
  return user.id;
}

export async function verifyLogin(dir, name, password) {
  const user = await readUser(dir, name);
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
  const actual = await derive(password, salt, 64, hashOptions);
  return timingSafeEqual(actual, expected) && user ? user : null;
}

function signature(key, body) {
  return createHmac('sha256', key).update(body).digest('base64url');
}

// Guest credentials and account sessions use distinct MAC inputs even on the same installation.
export function issueGuestToken(key, verifiedGuest = null, now = Math.floor(Date.now() / 1000)) {
  const id = verifiedGuest?.id ?? randomBytes(24).toString('hex');
  const body = id + '.' + (now + guestLifetime);
  return body + '.' + signature(key, 'book-guest-v1\0' + body);
}

export function readGuestToken(key, token, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 105) return null;
  const match = /^([0-9a-f]{48})\.([0-9]{1,12})\.([a-zA-Z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, id, expires, mac] = match;
  const expected = signature(key, 'book-guest-v1\0' + id + '.' + expires);
  const expiresAt = Number(expires);
  if (expiresAt <= now || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return { id, expiresAt };
}

export async function openSession(dir, key, user) {
  const nonce = randomBytes(24).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + sessionLifetime;
  const body = [user.name, user.revision, exp, nonce].join('.');
  await writeFile(join(dir, 'sessions', nonce), '', storageOptions);
  return body + '.' + signature(key, body);
}

export async function readSession(dir, key, token) {
  if (!token || token.length > 240) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [name, revision, expires, nonce, mac] = parts;
  if (!validName(name) || !/^[0-9a-f]{48}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const expected = signature(key, parts.slice(0, 4).join('.'));
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) || Number(expires) <= Date.now() / 1000) return null;
  const user = await readUser(dir, name);
  if (!user || user.revision !== revision) return null;
  const path = join(dir, 'sessions', nonce);
  try { await access(path); }
  catch (err) { if (notFound(err)) return null; throw err; }
  return { name: user.name, id: user.id, path };
}
