import type { GuideMessage } from '@/lib/course-types';
import { guideSources } from '../lib/guide-message.ts';
import { eventData, GUIDE_STREAM_TYPE } from '../lib/guide-stream.ts';

export async function readGuideAnswer(response: Response, onText: (answer: string) => void): Promise<GuideMessage> {
  let answer = '';
  let model: unknown;
  let sources: unknown;
  if (response.headers.get('content-type')?.includes(GUIDE_STREAM_TYPE)) {
    let complete = false;
    for await (const data of eventData(response.body)) {
      let event;
      try { event = JSON.parse(data); } catch { throw new Error('收到的回答不完整，请重试。'); }
      if (event?.type === 'delta' && typeof event.text === 'string') {
        answer += event.text;
        if (answer.length > 16000) throw new Error('回答过长，请重试。');
        onText(answer);
      } else if (event?.type === 'done') {
        complete = true;
        model = event.model;
        sources = event.sources;
        break;
      } else {
        throw new Error('回答中断，已保留你的问题。请重试。');
      }
    }
    if (!complete) throw new Error('回答中断，已保留你的问题。请重试。');
  } else {
    const payload = await response.json() as { answer?: unknown; model?: unknown; sources?: unknown } | null;
    answer = typeof payload?.answer === 'string' ? payload.answer : '';
    model = payload?.model;
    sources = payload?.sources;
  }
  if (!answer.trim() || answer.length > 16000) throw new Error('模型没有返回可显示的回答，请重试。');
  return { role: 'assistant', content: answer, sources: guideSources(sources), ...(typeof model === 'string' ? { model: model.slice(0, 150) } : {}) };
}
