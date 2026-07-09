/** SSE parse/encode helpers shared by protocol bridges and OpenAI chat proxying. */

export function encodeSseBlock(event) {
  const lines = [];
  if (event.event && event.event !== 'message') lines.push(`event: ${event.event}`);
  for (const line of String(event.data ?? '').split('\n')) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

export function parseSseBlock(block) {
  const event = {
    event: 'message',
    data: ''
  };
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event.event = value;
    if (field === 'data') event.data += `${event.data ? '\n' : ''}${value}`;
  }
  return event;
}

export async function* readSseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let splitAt;
    while ((splitAt = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, splitAt);
      const match = buffer.slice(splitAt).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(splitAt + (match?.[0].length ?? 2));
      if (block.trim()) yield parseSseBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parseSseBlock(buffer);
}

/** Convert an array of OpenAI chat SSE data strings into async-iterable SSE events. */
export async function* openAIChunksToSseEvents(chunks = []) {
  for (const data of chunks) {
    yield { event: 'message', data: typeof data === 'string' ? data : JSON.stringify(data) };
  }
  yield { event: 'message', data: '[DONE]' };
}
