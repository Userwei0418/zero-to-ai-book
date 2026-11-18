import { env } from 'cloudflare:workers';
import { boundedJson, hash, json, protectedPost, reserveQuota, responseJson, short } from '@/lib/api-utils';

export async function POST(request: Request) {
  const access = protectedPost(request); if (access instanceof Response) return access;
  try {
    const body=await boundedJson(request,1048576); const action=short(body.action,16);
    if(body.cacheScope !== (await hash(access.id)).slice(0,32)) return json({status:'error',error:'登录账号已变化，请重新载入实验环境。',code:'identity_changed'},409);
    if(!['execute','reset','interrupt','status'].includes(action)) return json({error:'未知的实验操作。'},400);
    if(action==='execute' && (typeof body.code!=='string' || new TextEncoder().encode(body.code).byteLength>131072)) return json({status:'error',error:'代码必须是文本，且不超过128 KiB。请分成多个单元运行。'},400);
    const chapterId=short(body.chapterId,120);
    if(!/^[a-z0-9_-]+$/i.test(chapterId)) return json({error:'章节标识不正确。'},400);
    const isGPU=body.runtime==='gpu'; const url=isGPU?env.GPU_API_URL:env.SANDBOX_API_URL; const secret=isGPU?env.GPU_API_KEY:env.SANDBOX_API_KEY;
    if(!url||!secret) return json({status:'unavailable',error:isGPU?'这项训练需要独立算力环境，当前尚未连接。代码可以编辑和保存。':'这项实验需要完整 Linux 环境，当前尚未连接。浏览器 Python 实验仍可运行。',code:'runtime_not_configured'},503);
    if(new URL(url).protocol!=='https:') return json({status:'unavailable',error:'实验服务地址配置不正确。'},503);
    if(action==='execute'&&!(await reserveQuota(`runtime:${access.id}`,12,60))) return json({status:'unavailable',error:'运行请求过于频繁，请稍后再试。'},429);
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(access.id));
    const sessionKey=Array.from(new Uint8Array(signature)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const response=await fetch(`${url.replace(/\/$/,'')}/${action}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({sessionKey,chapterId,code:short(body.code,131072),files:body.files,cellId:short(body.cellId,120)}),signal:AbortSignal.timeout(action==='execute'?100000:15000)});
    if(!response.ok) return json({status:'error',error:'实验服务未能完成操作，请稍后重试。',upstreamStatus:response.status},502);
    return json(await responseJson(response, 3*1048576));
  } catch {return json({status:'error',error:'实验连接中断或等待超时，请检查会话状态后重试。'},502);}
}
