import { env } from 'cloudflare:workers';
import { accessFlags, json, readerIdentity, responseJson } from '@/lib/api-utils';
export async function GET(request: Request) {
  const reader = readerIdentity(request);
  const info = { aiConfigured: !!env.TOKENPLAN_API_KEY, remoteRuntimeConfigured: !!(env.SANDBOX_API_URL && env.SANDBOX_API_KEY), gpuConfigured: !!(env.GPU_API_URL && env.GPU_API_KEY), persistenceConfigured: !!env.DB, ...accessFlags(reader) };
  if(new URL(request.url).searchParams.get('checkAI')==='1' && reader?.kind === 'account' && env.TOKENPLAN_API_KEY) {
    try {
      const response=await fetch(`${(env.TOKENPLAN_BASE_URL||'https://token.sensetime.com/api/v1').replace(/\/$/,'')}/models`,{headers:{Authorization:`Bearer ${env.TOKENPLAN_API_KEY}`},signal:AbortSignal.timeout(15000)});
      const data=response.ok ? await responseJson(response, 256*1024) as {data?:Array<{id?:string}>} : null;
      return json({...info,modelCheck:{status:response.status,configuredModel:env.TOKENPLAN_MODEL,models:data?.data?.map(m=>m.id).filter(Boolean).slice(0,30)||[]}});
    }catch{return json({...info,modelCheck:{status:'connection_failed'}});}
  }
  return json(info);
}
