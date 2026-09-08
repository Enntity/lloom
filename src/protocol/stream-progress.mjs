import { parseSseBlock } from './sse.mjs';
import { openAIStreamChunkHasContent } from './text.mjs';

// This deadline bounds inactivity, not the duration of a productive generation.
// Provider comments and empty role deltas are not evidence of model progress.
export async function fetchWithStreamProgress(fetchResponse, { signal, idleMs }) {
  if (!(idleMs > 0)) return fetchResponse(signal);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  let generationId = null;
  let receivedHeaders = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error(`Upstream stream made no model progress for ${idleMs}ms`), {
            code: 'upstream_no_progress',
            statusCode: 504,
            upstreamGenerationId: generationId,
            upstreamHeadersReceived: receivedHeaders
          })
        ),
      idleMs
    );
    timer.unref?.();
  };
  arm();
  try {
    const response = await fetchResponse(combined);
    receivedHeaders = true;
    generationId = response.headers.get('x-generation-id');
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const body = new ReadableStream({
      async pull(output) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            output.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(pending))) {
            const event = parseSseBlock(pending.slice(0, match.index));
            pending = pending.slice(match.index + match[0].length);
            if (event.data === '[DONE]') clearTimeout(timer);
            else if (event.data) {
              try {
                const chunk = JSON.parse(event.data);
                if (chunk.error) clearTimeout(timer);
                else if (openAIStreamChunkHasContent(chunk)) arm();
              } catch {
                /* Invalid data cannot extend the deadline. */
              }
            }
          }
          // Bound framing state even for a malformed stream without delimiters.
          if (pending.length > 1024 * 1024)
            throw Object.assign(new Error('Upstream SSE frame exceeds 1 MiB'), { statusCode: 502 });
          output.enqueue(value);
        } catch (error) {
          clearTimeout(timer);
          void reader.cancel().catch(() => {});
          output.error(controller.signal.aborted ? controller.signal.reason : error);
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        return reader.cancel(reason);
      }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    clearTimeout(timer);
    throw controller.signal.aborted ? controller.signal.reason : error;
  }
}
