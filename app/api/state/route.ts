import { env } from 'cloudflare:workers';
import { boundedJson, hash, json, protectedPost, reserveQuota, userId } from '@/lib/api-utils';
import { validateLearningState } from '@/lib/learning-state-validation';
import { ZodError } from 'zod';

export async function GET(request: Request) {
  const id = userId(request);
  if (!id) return json({ state: {}, revision: 0, authenticated: false, cacheScope: 'anonymous' });
  const cacheScope = (await hash(id)).slice(0,32);
  if (!env.DB) return json({ error: '云端保存暂不可用，当前修改请保留在此设备。', authenticated: true, cacheScope }, 503);
  const row = await env.DB.prepare('SELECT state, revision, updated_at FROM learning_state WHERE user_id = ?').bind(id).first<{state: string; revision: number; updated_at: number}>();
  return json({ state: row ? JSON.parse(row.state) : {}, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null, authenticated: true, cacheScope });
}
export async function PUT(request: Request) {
  const access = protectedPost(request); if (access instanceof Response) return access;
  if (!env.DB) return json({ error: '云端保存暂不可用，请保留本地修改。' }, 503);
  try {
    const body = await boundedJson(request, 2 * 1024 * 1024);
    const expectedScope = (await hash(access.id)).slice(0,32);
    if (body.cacheScope !== expectedScope) return json({error:'登录账号已变化，请重新载入当前账号的学习记录。',code:'identity_changed'},409);
    const revision = body.revision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 0 || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return json({ error: '学习记录格式不正确。' }, 400);
    if (!(await reserveQuota(`save:${access.id}`, 120, 60))) return json({error:'保存较为频繁，请稍后重试。'},429);
    const state = JSON.stringify(validateLearningState(body.state));
    const now = Date.now();
    let result;
    if (revision === 0) {
      result = await env.DB.prepare('INSERT INTO learning_state (user_id, state, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING revision')
        .bind(access.id, state, now).first<{revision: number}>();
    } else {
      result = await env.DB.prepare('UPDATE learning_state SET state = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision')
        .bind(state, now, access.id, revision).first<{revision: number}>();
    }
    if (!result) {
      const current = await env.DB.prepare('SELECT state, revision FROM learning_state WHERE user_id = ?').bind(access.id).first<{state: string; revision: number}>();
      return json({ error: '另一处已更新学习记录。已保留你的本地修改，请选择要继续的记录。', code: 'revision_conflict', revision: current?.revision ?? 0, state: current ? JSON.parse(current.state) : {} }, 409);
    }
    return json({ revision: result.revision, updatedAt: now });
  } catch (error) { return json({ error: error instanceof ZodError ? error.issues[0]?.message || '学习记录格式不正确。' : '保存失败：数据过长或格式不正确。' }, 400); }
}
export async function DELETE(request: Request) {
  const access = protectedPost(request); if (access instanceof Response) return access;
  if(request.headers.get('x-learning-scope') !== (await hash(access.id)).slice(0,32)) return json({error:'登录账号已变化，请刷新后再删除记录。',code:'identity_changed'},409);
  if (!env.DB) return json({error:'云端保存暂不可用。'},503);
  await env.DB.prepare('DELETE FROM learning_state WHERE user_id = ?').bind(access.id).run();
  await env.DB.prepare('DELETE FROM guide_cache WHERE user_id = ?').bind(access.id).run();
  return json({deleted:true});
}
