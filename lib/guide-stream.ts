/** Read SSE events across arbitrary UTF-8 and network packet boundaries. */
export async function* eventData(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new Error('没有收到导读内容。');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let buffer = '';
  let fields: string[] = [];
  let eof = false;
  try {
    while (!eof) {
      const next = await reader.read();
      eof = next.done;
      size += next.value?.byteLength || 0;
      if (size > 512 * 1024) throw new Error('导读响应超过长度限制。');
      buffer += decoder.decode(next.value, { stream: !eof });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (fields.length) yield fields.join('\n');
          fields = [];
        } else if (line === 'data' || line.startsWith('data:')) {
          fields.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } finally {
    if (!eof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const GUIDE_STREAM_TYPE = 'text/event-stream';
