// An HTTP failure is already known from its headers. Its diagnostic body must
// never hold error delivery hostage to a provider's connection lifetime.
export async function readErrorDiagnostic(response, { timeoutMs = 1000, maxBytes = 16384 } = {}) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: true }), timeoutMs);
  });
  try {
    while (bytes < maxBytes) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      const part = value.subarray(0, maxBytes - bytes);
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
      try {
        // A complete JSON diagnostic needs no EOF to become actionable.
        JSON.parse(text);
        break;
      } catch {
        // Partial JSON or a plain-text diagnostic; keep the bounded prefix.
      }
    }
  } catch {
    // A broken body must not erase the HTTP status we already received.
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

export function streamProviderError(payload) {
  if (!payload?.error) return null;
  const detail = payload.error;
  const suppliedStatus = Number(detail.status ?? detail.code);
  return Object.assign(new Error(detail.message || 'Upstream stream failed'), {
    code: typeof detail.code === 'string' ? detail.code : 'upstream_error',
    statusCode: suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 502
  });
}
