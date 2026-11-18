import { eventData } from '@/lib/guide-stream';

/** Only expose visible assistant text, never provider diagnostics or reasoning tokens. */
export async function readModelStream(body: ReadableStream<Uint8Array> | null, onText: (text: string) => void | Promise<void>) {
  let answer = '';
  let model: string | undefined;
  let ended = false;
  for await (const data of eventData(body)) {
    if (data === '[DONE]') { ended = true; break; }
    const chunk = JSON.parse(data);
    if (!chunk || chunk.error || !Array.isArray(chunk.choices)) throw new Error('Invalid model chunk');
    if (typeof chunk.model === 'string') model = chunk.model.slice(0, 150);
    const choice = chunk.choices.find((item: {index?: number}) => item?.index === undefined || item.index === 0);
    if (!choice) continue;
    const text = choice.delta?.content;
    if (typeof text === 'string' && text) {
      if (answer.length + text.length > 16000) throw new Error('Answer too large');
      answer += text;
      await onText(text);
    }
    if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') ended = true;
    else if (choice.finish_reason != null) throw new Error('Model did not finish');
  }
  if (!ended || !answer.trim()) throw new Error('Incomplete model answer');
  return { answer, model };
}
