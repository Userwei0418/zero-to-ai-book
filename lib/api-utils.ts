import { env } from 'cloudflare:workers';

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
type Reader = { id: string; kind: 'account' | 'guest' };
export function readerIdentity(request: Request): Reader | null {
  const account = request.headers.get('oai-authenticated-user-id')?.slice(0, 200);
  if (account) return { id: account, kind: 'account' };
  // Only the private Node adapter enables the ingress-verified guest header.
  if (env.BOOK_GUEST_ACCESS !== '1') return null;
  const guest = request.headers.get('x-book-guest-id');
  return guest && /^guest:[0-9a-f]{48}$/.test(guest) ? { id: guest, kind: 'guest' } : null;
}
export function accessFlags(reader: Reader | null) {
  const authenticated = reader?.kind === 'account';
  return env.BOOK_GUEST_ACCESS === '1'
    ? { authenticated, recognized: !!reader, identityKind: reader?.kind || 'anonymous' }
    : { authenticated };
}
export async function readerScope(reader: Reader) {
  return (await hash(reader.id)).slice(0, 32);
}
export function quotaLimit(setting: string | undefined, fallback: number, maximum: number) {
  if (!setting || !/^\d+$/.test(setting)) return fallback;
  return Math.min(Number(setting), maximum);
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(env.PUBLIC_ORIGIN || request.url).origin;
}
export async function boundedJson(request: Request, max = 32768): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('请发送 JSON 格式的数据。');
  if (Number(request.headers.get('content-length') || 0) > max) throw new Error('提交的内容过长。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求内容为空。');
  let total = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error('提交的内容过长。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式不正确。');
  return value;
}
export const short = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
export async function responseJson(response: Response, max: number): Promise<unknown> {
  if (Number(response.headers.get('content-length') || 0) > max) { await response.body?.cancel(); throw new Error('服务响应过长。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('服务响应为空。');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > max) { await reader.cancel(); throw new Error('服务响应过长。'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function reserveQuota(key: string, limit: number, seconds: number) {
  if (!env.DB) throw new Error('学习服务正在准备，请稍后重试。');
  const now = Math.floor(Date.now() / 1000); const bucket = Math.floor(now / seconds);
  if (Math.random() < 1/64) await env.DB.prepare('DELETE FROM request_quota WHERE expires_at < ?').bind(now).run();
  const row = await env.DB.prepare('INSERT INTO request_quota (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(`${key}:${bucket}`, (bucket + 1) * seconds).first<{count: number}>();
  return !!row && row.count <= limit;
}
export function protectedPost(request: Request): Reader | Response {
  const reader = readerIdentity(request);
  if (!reader) return env.BOOK_GUEST_ACCESS === '1'
    ? json({ error: '请允许本站使用访客 Cookie，然后刷新书页。', code: 'reader_session_required' }, 401)
    : json({ error: '请登录后使用此功能。', code: 'sign_in_required' }, 401);
  if (!sameOrigin(request)) return json({ error: '请求来源不匹配，请从书页重新操作。' }, 403);
  return reader;
}
