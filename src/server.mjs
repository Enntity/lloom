import http from "node:http";
import { createRegistry, UnknownModelError } from "./registry.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";

const JSON_TYPE = "application/json; charset=utf-8";
const SSE_TYPE = "text/event-stream; charset=utf-8";

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key");
}

function sendJson(res, status, value, headers = {}) {
  setCors(res);
  res.writeHead(status, {
    "content-type": JSON_TYPE,
    ...headers,
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function errorBody(message, {
  type = "invalid_request_error",
  code = "error",
  model,
} = {}) {
  return {
    error: {
      message,
      type,
      code,
      model,
    },
  };
}

async function readBody(req, { limitBytes = 64 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function hasAuth(req, config) {
  if (config.security?.allowMissingAuth === true) return true;
  const configured = new Set(config.security?.apiKeys ?? []);
  const bearer = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const xApiKey = req.headers["x-api-key"];
  return configured.has(bearer) || configured.has(xApiKey);
}

function upstreamUrl(backend, path) {
  const suffix = path.startsWith("/v1/") ? path.slice(3) : path;
  return `${stripTrailingSlash(backend.baseUrl)}${suffix}`;
}

function backendHeaders(backend, extra = {}) {
  const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : backend.apiKey;
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

function copyResponseHeaders(upstream) {
  const headers = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

function sseHeaders(extra = {}) {
  return {
    "content-type": SSE_TYPE,
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...extra,
  };
}

function openAIChoiceText(choice) {
  const content = choice?.message?.content ?? choice?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => part?.text ?? "")
      .filter(Boolean)
      .join("");
  }
  return "";
}

function responseUsageFromOpenAI(usage = {}) {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    input_tokens_details: usage.prompt_tokens_details ?? usage.input_tokens_details ?? {},
    output_tokens_details: usage.completion_tokens_details ?? usage.output_tokens_details ?? {},
  };
}

function responsesContentPartToOpenAI(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (!part || typeof part !== "object") return { type: "text", text: String(part ?? "") };
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    return { type: "text", text: part.text ?? "" };
  }
  if (part.type === "input_image") {
    const imageUrl = part.image_url ?? part.url;
    if (imageUrl) {
      return {
        type: "image_url",
        image_url: {
          url: imageUrl,
        },
      };
    }
  }
  if (part.type === "image_url") return part;
  return { type: "text", text: part.text ?? JSON.stringify(part) };
}

function responsesInputToMessages(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({
      role: "system",
      content: String(body.instructions),
    });
  }
  const input = body.input ?? body.messages ?? "";
  if (typeof input === "string") {
    messages.push({
      role: "user",
      content: input,
    });
    return messages;
  }
  if (!Array.isArray(input)) {
    messages.push({
      role: "user",
      content: String(input ?? ""),
    });
    return messages;
  }
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type && item.type !== "message") {
      messages.push({
        role: "user",
        content: [responsesContentPartToOpenAI(item)],
      });
      continue;
    }
    const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
    const content = Array.isArray(item.content)
      ? item.content.map(responsesContentPartToOpenAI)
      : item.content ?? "";
    messages.push({ role, content });
  }
  return messages;
}

function responsesToOpenAIChat(body, resolvedModel) {
  return {
    model: resolvedModel.model.upstreamModel,
    messages: responsesInputToMessages(body),
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream === true,
    stream_options: body.stream === true ? { include_usage: true } : undefined,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
}

function openAIToResponses(responseJson, requestedModel) {
  const choice = responseJson.choices?.[0] ?? {};
  const text = openAIChoiceText(choice);
  const responseId = responseJson.id?.startsWith("resp_") ? responseJson.id : `resp_${responseJson.id ?? Date.now()}`;
  const outputItem = {
    id: `msg_${responseId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: text ? [{
      type: "output_text",
      text,
      annotations: [],
    }] : [],
  };
  return {
    id: responseId,
    object: "response",
    created_at: responseJson.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output: [outputItem],
    output_text: text,
    parallel_tool_calls: true,
    usage: responseUsageFromOpenAI(responseJson.usage),
    error: null,
    incomplete_details: null,
    metadata: responseJson.metadata ?? {},
  };
}

function anthropicStopReason(choice) {
  const reason = choice?.finish_reason;
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return reason ?? "end_turn";
}

function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = [];
  for (const part of content) {
    if (part?.type === "text") {
      parts.push({ type: "text", text: part.text ?? "" });
    } else if (part?.type === "image" && part.source?.type === "base64") {
      const mediaType = part.source.media_type ?? "image/png";
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${mediaType};base64,${part.source.data ?? ""}`,
        },
      });
    }
  }
  return parts.length ? parts : "";
}

function anthropicMessagesToOpenAI(body, resolvedModel) {
  const messages = [];
  if (body.system) {
    const system = Array.isArray(body.system)
      ? body.system.map(part => part?.text ?? "").join("\n")
      : String(body.system);
    if (system.trim()) messages.push({ role: "system", content: system });
  }
  for (const message of body.messages ?? []) {
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: anthropicContentToOpenAI(message.content),
    });
  }
  return {
    model: resolvedModel.model.upstreamModel,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream === true,
    stream_options: body.stream === true ? { include_usage: true } : undefined,
    tools: body.tools,
  };
}

function openAIToAnthropic(responseJson, requestedModel) {
  const choice = responseJson.choices?.[0] ?? {};
  const text = openAIChoiceText(choice);
  return {
    id: responseJson.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: anthropicStopReason(choice),
    stop_sequence: null,
    usage: {
      input_tokens: responseJson.usage?.prompt_tokens ?? 0,
      output_tokens: responseJson.usage?.completion_tokens ?? 0,
    },
  };
}

async function fetchUpstream({ backend, path, body, headers = {} }) {
  const controller = new AbortController();
  const timeoutMs = backend.timeoutMs ?? 1800000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(upstreamUrl(backend, path), {
      method: "POST",
      headers: backendHeaders(backend, headers),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyUpstreamStream(res, upstream) {
  setCors(res);
  res.writeHead(upstream.status, copyResponseHeaders(upstream));
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) {
    res.write(Buffer.from(chunk));
  }
  res.end();
}

async function proxyRawResponse(res, upstream) {
  const text = await upstream.text();
  setCors(res);
  res.writeHead(upstream.status, copyResponseHeaders(upstream));
  res.end(text);
}

function parseSseBlock(block) {
  const event = {
    event: "message",
    data: "",
  };
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event.event = value;
    if (field === "data") event.data += `${event.data ? "\n" : ""}${value}`;
  }
  return event;
}

async function* readSseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
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

function openAIChunkText(chunk) {
  const delta = chunk?.choices?.[0]?.delta ?? {};
  const content = delta.content ?? delta.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => part?.text ?? "")
      .filter(Boolean)
      .join("");
  }
  return "";
}

async function streamAnthropicFromOpenAI(res, upstream, requestedModel) {
  setCors(res);
  res.writeHead(200, sseHeaders());

  const messageId = `msg_${Date.now()}`;
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "text",
      text: "",
    },
  });

  let usage = {
    input_tokens: 0,
    output_tokens: 0,
  };
  let stopReason = "end_turn";

  for await (const event of readSseEvents(upstream.body)) {
    if (event.data === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
      };
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) {
      stopReason = anthropicStopReason(choice);
    }
    const text = openAIChunkText(chunk);
    if (text) {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text,
        },
      });
    }
  }

  writeSse(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage,
  });
  writeSse(res, "message_stop", {
    type: "message_stop",
  });
  res.end();
}

async function streamResponsesFromOpenAI(res, upstream, requestedModel) {
  setCors(res);
  res.writeHead(200, sseHeaders());

  const responseId = `resp_${Date.now()}`;
  const outputItemId = `msg_${responseId}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const responseBase = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: requestedModel,
    output: [],
    output_text: "",
    usage: null,
  };
  writeSse(res, "response.created", {
    type: "response.created",
    response: responseBase,
  });
  writeSse(res, "response.in_progress", {
    type: "response.in_progress",
    response: responseBase,
  });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: outputItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
  writeSse(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
      annotations: [],
    },
  });

  let fullText = "";
  let usage = responseUsageFromOpenAI();
  let stopReason = "stop";
  for await (const event of readSseEvents(upstream.body)) {
    if (event.data === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (chunk.usage) {
      usage = responseUsageFromOpenAI(chunk.usage);
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    const text = openAIChunkText(chunk);
    if (text) {
      fullText += text;
      writeSse(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    }
  }

  writeSse(res, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    text: fullText,
  });
  writeSse(res, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: fullText,
      annotations: [],
    },
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: outputItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: fullText,
        annotations: [],
      }],
    },
  });
  writeSse(res, "response.completed", {
    type: "response.completed",
    response: {
      ...responseBase,
      status: "completed",
      output_text: fullText,
      output: [{
        id: outputItemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: fullText,
          annotations: [],
        }],
      }],
      usage,
      incomplete_details: stopReason === "length" ? { reason: "max_output_tokens" } : null,
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function createSwitchyardServer(config, {
  logger = console,
  runtimeManager = new RuntimeManager(config, { logger }),
} = {}) {
  const registry = createRegistry(config);

  async function handleOpenAIChat(req, res) {
    const body = await readJson(req);
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    if ((resolved.model.kind ?? "chat") !== "chat") {
      sendJson(res, 400, errorBody(`model ${resolved.requestedId} is not a chat model`, {
        code: "wrong_model_kind",
        model: resolved.requestedId,
      }));
      return;
    }
    await runtimeManager.ensure(resolved.model.runtime);
    const upstream = await fetchUpstream({
      backend: resolved.backend,
      path: "/v1/chat/completions",
      body: {
        ...body,
        model: resolved.model.upstreamModel,
      },
    });
    if (body.stream === true) {
      await proxyUpstreamStream(res, upstream);
    } else {
      await proxyRawResponse(res, upstream);
    }
  }

  async function handleOpenAIImages(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.imageModel;
    const resolved = registry.resolve(modelId);
    if ((resolved.model.kind ?? "chat") !== "image") {
      sendJson(res, 400, errorBody(`model ${resolved.requestedId} is not an image-generation model`, {
        code: "wrong_model_kind",
        model: resolved.requestedId,
      }));
      return;
    }
    await runtimeManager.ensure(resolved.model.runtime);
    const upstream = await fetchUpstream({
      backend: resolved.backend,
      path: "/v1/images/generations",
      body: {
        ...body,
        model: resolved.model.upstreamModel,
      },
    });
    await proxyRawResponse(res, upstream);
  }

  async function handleOpenAIResponses(req, res) {
    const body = await readJson(req);
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    if ((resolved.model.kind ?? "chat") !== "chat") {
      sendJson(res, 400, errorBody(`model ${resolved.requestedId} is not a chat model`, {
        code: "wrong_model_kind",
        model: resolved.requestedId,
      }));
      return;
    }
    await runtimeManager.ensure(resolved.model.runtime);
    const upstream = await fetchUpstream({
      backend: resolved.backend,
      path: "/v1/chat/completions",
      body: responsesToOpenAIChat(body, resolved),
    });
    if (body.stream === true) {
      if (!upstream.ok) {
        await proxyRawResponse(res, upstream);
        return;
      }
      await streamResponsesFromOpenAI(res, upstream, resolved.requestedId);
      return;
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      setCors(res);
      res.writeHead(upstream.status, copyResponseHeaders(upstream));
      res.end(text);
      return;
    }
    sendJson(res, 200, openAIToResponses(JSON.parse(text), resolved.requestedId));
  }

  async function handleAnthropicMessages(req, res) {
    const body = await readJson(req);
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    await runtimeManager.ensure(resolved.model.runtime);
    const upstream = await fetchUpstream({
      backend: resolved.backend,
      path: "/v1/chat/completions",
      body: anthropicMessagesToOpenAI(body, resolved),
    });
    if (body.stream === true) {
      if (!upstream.ok) {
        await proxyRawResponse(res, upstream);
        return;
      }
      await streamAnthropicFromOpenAI(res, upstream, resolved.requestedId);
      return;
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      setCors(res);
      res.writeHead(upstream.status, copyResponseHeaders(upstream));
      res.end(text);
      return;
    }
    const responseJson = JSON.parse(text);
    sendJson(res, 200, openAIToAnthropic(responseJson, resolved.requestedId));
  }

  async function handleRequest(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    try {
      if (!hasAuth(req, config)) {
        sendJson(res, 401, errorBody("missing or invalid authorization token", {
          type: "authentication_error",
          code: "unauthorized",
        }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, name: config.name ?? "Switchyard" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: registry.openAIModels(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/gateway/models") {
        sendJson(res, 200, {
          models: registry.catalogModels({ includeAliases: true }),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/gateway/routing") {
        sendJson(res, 200, {
          aliases: config.aliases ?? {},
          defaults: config.defaults ?? {},
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/gateway/status") {
        sendJson(res, 200, {
          ok: true,
          server: config.server,
          defaults: config.defaults,
          runtimeManager: await runtimeManager.status(),
        });
        return;
      }

      const stopMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/stop$/);
      if (req.method === "POST" && stopMatch) {
        sendJson(res, 200, await runtimeManager.stop(decodeURIComponent(stopMatch[1])));
        return;
      }

      const startMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/start$/);
      if (req.method === "POST" && startMatch) {
        const body = await readJson(req);
        sendJson(res, 200, await runtimeManager.start(decodeURIComponent(startMatch[1]), {
          force: body.force !== false,
          warmup: body.warmup !== false,
          reason: "admin-start",
        }));
        return;
      }

      const warmupMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/warmup$/);
      if (req.method === "POST" && warmupMatch) {
        sendJson(res, 200, await runtimeManager.warmupById(decodeURIComponent(warmupMatch[1])));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleOpenAIChat(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        await handleOpenAIImages(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleOpenAIResponses(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleAnthropicMessages(req, res);
        return;
      }

      sendJson(res, 404, errorBody(`unknown route: ${url.pathname}`, {
        code: "not_found",
      }));
    } catch (error) {
      if (error instanceof UnknownModelError) {
        sendJson(res, error.statusCode, errorBody(error.message, {
          code: error.code,
          model: error.modelId,
        }));
        return;
      }
      logger.error?.(error);
      sendJson(res, 500, errorBody(error?.message ?? String(error), {
        type: "server_error",
        code: "server_error",
      }));
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      logger.error?.(error);
      sendJson(res, 500, errorBody(error?.message ?? String(error), {
        type: "server_error",
        code: "server_error",
      }));
    });
  });

  return {
    server,
    registry,
    runtimeManager,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => {
          reject(error);
        };
        server.once("error", onError);
        server.listen(config.server.port, config.server.host, () => {
          server.off("error", onError);
          runtimeManager.startKeepWarm()
            .catch(error => logger.error?.(error));
          resolve(server);
        });
      });
    },
  };
}
