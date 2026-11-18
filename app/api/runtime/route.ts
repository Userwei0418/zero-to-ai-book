import { env } from 'cloudflare:workers';
import { boundedJson, hash, json, protectedPost, reserveQuota, responseJson } from '@/lib/api-utils';

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const privateGateway = 'http://sandbox-gateway:8090';
const maxBody = 2 * 1024 * 1024;

export async function POST(request: Request) {
  const access = protectedPost(request);
  if (access instanceof Response) return access;

  let body: Record<string, unknown>;
  try {
    body = await boundedJson(request, maxBody);
  } catch {
    return json({ status: 'error', error: '实验请求须为 JSON，大小上限为 2 MiB。' }, 400);
  }

  if (body.cacheScope !== (await hash(access.id)).slice(0, 32)) {
    return json({ status: 'error', error: '登录账号已变化，请重新载入实验环境。', code: 'identity_changed' }, 409);
  }
  const action = body.action;
  if (action !== 'execute' && action !== 'reset' && action !== 'interrupt' && action !== 'status') {
    return json({ error: '未知的实验操作。' }, 400);
  }
  const chapterId = body.chapterId;
  if (typeof chapterId !== 'string' || !identifier.test(chapterId)) {
    return json({ error: '章节标识不正确。' }, 400);
  }
  if (action === 'execute') {
    if (typeof body.code !== 'string' || new TextEncoder().encode(body.code).byteLength > 65536) {
      return json({ status: 'error', error: '每次最多运行 64 KiB 的代码，请分成多个单元。' }, 400);
    }
    if (typeof body.cellId !== 'string' || !identifier.test(body.cellId)) {
      return json({ status: 'error', error: '代码单元标识不正确。' }, 400);
    }
  }

  const gpu = body.runtime === 'gpu';
  const configured = gpu ? env.GPU_API_URL : env.SANDBOX_API_URL;
  const secret = gpu ? env.GPU_API_KEY : env.SANDBOX_API_KEY;
  if (!configured || !secret) {
    return json({ status: 'unavailable', error: gpu ? '这项训练需要独立 GPU 服务。' : '本章远程运行服务尚未配置，浏览器实验仍可运行。', code: 'runtime_not_configured' }, 503);
  }
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    return json({ status: 'unavailable', error: '实验服务地址配置不正确。' }, 503);
  }
  const onPrivateNetwork = !gpu && env.SELF_HOSTED_SANDBOX === '1' && base.href === privateGateway + '/';
  if ((base.protocol !== 'https:' && !onPrivateNetwork) || base.username || base.password || base.search || base.hash) {
    return json({ status: 'unavailable', error: '实验服务地址配置不正确。' }, 503);
  }
  try {
    if (action === 'execute' && !(await reserveQuota(`runtime:${access.id}`, 12, 60))) {
      return json({ status: 'unavailable', error: '运行请求过于频繁，请稍后重试。' }, 429);
    }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(access.id));
    const sessionKey = Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
    const payload = action === 'execute'
      ? { sessionKey, chapterId, code: body.code, files: body.files, cellId: body.cellId }
      : { sessionKey, chapterId };
    const response = await fetch(`${base.href.replace(/\/$/, '')}/${action}`, {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(action === 'execute' ? 100000 : 15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: '实验代码或文件超出网关接受的格式或大小。',
        409: '当前实验正在运行，请等待执行完成或点击停止。',
        413: '实验文件总量过大，请缩小后再试。',
        429: '运行名额或请求配额已满，请结束空闲章节或稍后再试。',
        503: '实验环境暂时没有可用容量，请稍后再试。',
      };
      return json({ status: 'error', error: messages[response.status] ?? '实验网关连接失败，请检查服务配置。', upstreamStatus: response.status }, messages[response.status] ? response.status : 502);
    }
    return json(await responseJson(response, 3 * 1048576));
  } catch {
    return json({ status: 'error', error: '实验连接中断或等待超时，请检查会话状态后重试。' }, 502);
  }
}
