/** Credential-bearing web providers live here, never in an entity prompt. */
export function webFunctionStatus(config = {}) {
  return Object.fromEntries(
    ['search', 'read'].map((name) => {
      const service = config.web?.[name];
      return [
        name,
        {
          configured: Boolean(
            service && service.enabled !== false && service.apiKey && (name !== 'search' || service.cx)
          ),
          provider: name === 'search' ? 'google-cse' : 'jina',
          endpoint: `/v1/web/${name}`
        }
      ];
    })
  );
}

function failure(message, status, retryAfter) {
  return {
    status,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
    body: { error: { message, status, code: 'web_provider_error' } }
  };
}

async function boundedText(response, limit = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('provider_response_too_large');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function executeWebFunction(name, args, config, { fetchFn = fetch, signal } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('A JSON object is required', 400);
  // Copy config before the first await: hot reload cannot split one request across providers.
  const service = { ...config.web?.[name] };
  if (!webFunctionStatus({ web: { [name]: service } })[name]?.configured)
    return failure(`Web ${name} is not configured`, 503);
  let url;
  const headers = { accept: name === 'search' ? 'application/json' : 'text/plain' };
  if (name === 'search') {
    if (typeof args.q !== 'string' || !args.q.trim() || args.q.length > 10000)
      return failure('A nonempty search query is required (maximum 10000 characters)', 400);
    if (args.num != null && (!Number.isInteger(args.num) || args.num < 1 || args.num > 10))
      return failure('num must be between 1 and 10', 400);
    url = new URL(service.endpoint || 'https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', service.apiKey);
    url.searchParams.set('cx', service.cx);
    url.searchParams.set('q', args.q.trim());
    url.searchParams.set('num', String(args.num ?? 8));
    for (const key of ['dateRestrict', 'siteSearch', 'siteSearchFilter', 'safe']) {
      if (typeof args[key] === 'string') url.searchParams.set(key, args[key]);
    }
  } else {
    let target;
    try {
      target = new URL(args.url);
    } catch {
      return failure('An absolute HTTP(S) URL is required', 400);
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return failure('An absolute HTTP(S) URL without credentials is required', 400);
    url = new URL(
      `${(service.endpoint || 'https://r.jina.ai').replace(/\/+$/, '')}/${encodeURIComponent(target.href)}`
    );
    headers.authorization = `Bearer ${service.apiKey}`;
  }
  const timeout = AbortSignal.timeout(service.timeoutMs || 30000);
  try {
    const response = await fetchFn(url, {
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        `Web ${name} provider returned HTTP ${response.status}`,
        response.status,
        response.headers.get('retry-after')
      );
    }
    const text = await boundedText(response);
    if (name === 'read')
      return {
        status: 200,
        body: {
          _type: 'SearchResponse',
          value: [
            { title: 'Webpage Content', url: args.url, content: text.slice(0, 40000), truncated: text.length > 40000 }
          ]
        }
      };
    const payload = JSON.parse(text);
    if (payload.error) return failure('Search provider rejected the request', 502);
    return {
      status: 200,
      body: {
        _type: 'SearchResponse',
        query: args.q,
        totalEstimated: payload.searchInformation?.totalResults || null,
        value: (payload.items || []).map((item, index) => ({
          searchResultId: `cse-${Date.now()}-${index}`,
          title: item.title || '',
          url: item.link || '',
          snippet: item.snippet || '',
          displayLink: item.displayLink || ''
        }))
      }
    };
  } catch {
    // Provider exceptions can contain credential-bearing URLs; never return their text.
    return failure(`Web ${name} provider request failed`, timeout.aborted ? 504 : 502);
  }
}

export function validateWebFunctions(web = {}) {
  const errors = [];
  for (const name of ['search', 'read']) {
    const service = web[name];
    if (!service || service.enabled === false) continue;
    if (service.endpoint) {
      try {
        const url = new URL(service.endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        errors.push(`web.${name}.endpoint must be an HTTP(S) URL without credentials`);
      }
    }
    if (
      service.timeoutMs != null &&
      (!Number.isInteger(service.timeoutMs) || service.timeoutMs < 1 || service.timeoutMs > 300000)
    )
      errors.push(`web.${name}.timeoutMs must be between 1 and 300000`);
  }
  return errors;
}
