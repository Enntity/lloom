/**
 * Egress redaction: scrub credentials out of request text before the gateway
 * forwards it to a backend outside the local network.
 *
 * Opt-in through `security.redactEgress` (every external backend) or
 * `backends.<id>.redact` (one backend, either direction). Matches become
 * `[secret]`; labelled values keep their label. Patterns follow Tessera's
 * Steward redactor. Matched values are never returned or logged, only counted.
 */

import { isIP } from 'node:net';
import { isFederatedGatewayBackend } from './cluster.mjs';
import { isLoopbackAddress } from './security.mjs';

const SECRET = '[secret]';

// Whole-token credential formats. No character class admits a quote or a
// backslash, so redacting inside JSON-encoded text keeps it valid JSON.
const SECRET_PATTERNS = [
  // Also covers OpenRouter `sk-or-v1-…` keys.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\blloom_[a-z]+_[0-9a-f]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:r8|hf|jina|xai)_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];

// PEM private keys, BEGIN through END. Scanned with two linear searches rather
// than one lazy regex, which goes quadratic over many unterminated BEGIN lines.
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

function replacePrivateKeys(text, replacement) {
  let output = '';
  let cursor = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    if (!PEM_END.exec(text)) break;
    output += text.slice(cursor, begin.index) + replacement();
    cursor = PEM_END.lastIndex;
    PEM_BEGIN.lastIndex = cursor;
  }
  return cursor ? output + text.slice(cursor) : text;
}

// scheme://user:password@host keeps scheme, user and host.
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#"'\\]*:)([^\s@/?#"'\\]+)@/gi;

// A credential label (bearer, *api_key, *token, *secret, *password, …) and its
// value. The value is 6+ characters, so "token: 500" and prose stay intact.
const LABELLED_VALUE =
  /\b((?:authorization:\s*)?bearer\s+|[A-Z0-9_]*(?:(?:api|secret|private|access)[_-]?key|secret[_-]?access[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)(?!\[secret\])([^\s"'\\]{6,})/gi;

const TRAILING_PUNCTUATION = /[,;)\]}]+$/;

// An unquoted labelled value that reads as code or a placeholder rather than a
// literal: an expression, a variable reference, a member path, or a word with
// no digit or symbol (`getToken`, `string`, `None`, `YOUR_API_KEY`).
function looksLikeCode(value) {
  return (
    /[()[\]{}<>]/.test(value) ||
    /^[$=<>!&|%]/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) ||
    /^[A-Za-z_.$-]+$/.test(value)
  );
}

/** Replace credentials in one string. Returns the text and a match count. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return { text, count: 0 };
  let count = 0;
  const replacement = () => {
    count += 1;
    return SECRET;
  };
  let output = replacePrivateKeys(text, replacement);
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  output = output.replace(URL_CREDENTIAL, (match, prefix, password) => {
    if (password === SECRET) return match;
    count += 1;
    return `${prefix}${SECRET}@`;
  });
  output = output.replace(LABELLED_VALUE, (match, label, rawValue) => {
    const tail = rawValue.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const value = rawValue.slice(0, rawValue.length - tail.length);
    const quoted = /["']$/.test(label);
    if (value.length < 6 || (!quoted && looksLikeCode(value))) return match;
    count += 1;
    return `${label}${SECRET}${tail}`;
  });
  return { text: output, count };
}

// Text-bearing keys inside messages, content parts, tool calls and Responses
// items. Image, audio and file parts carry none of them, so they pass through.
const NESTED_TEXT_FIELDS = [
  'content',
  'text',
  'arguments',
  'output',
  'input',
  'reasoning',
  'reasoning_content',
  'tool_calls',
  'function'
];
// Top-level request fields: Chat/Anthropic messages, legacy and media prompts,
// Responses/speech input, and instructions/system text.
const BODY_TEXT_FIELDS = ['messages', 'prompt', 'input', 'instructions', 'system'];

function redactValue(value, scrub) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const updated = redactValue(entry, scrub);
      changed ||= updated !== entry;
      return updated;
    });
    return changed ? next : value;
  }
  return value && typeof value === 'object' ? redactFields(value, NESTED_TEXT_FIELDS, scrub) : value;
}

function redactFields(object, fields, scrub) {
  let next = object;
  for (const field of fields) {
    if (!Object.hasOwn(object, field)) continue;
    const updated = redactValue(object[field], scrub);
    if (updated === object[field]) continue;
    if (next === object) next = { ...object };
    next[field] = updated;
  }
  return next;
}

/**
 * Redact the model-visible text of an outgoing JSON request body. The caller's
 * object is never mutated; it is returned as is when nothing matched.
 */
export function redactEgressBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, count: 0 };
  let count = 0;
  const scrub = (text) => {
    const result = redactSecrets(text);
    count += result.count;
    return result.count ? result.text : text;
  };
  const next = redactFields(body, BODY_TEXT_FIELDS, scrub);
  return { body: next, count };
}

function ipv4Internal(address) {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6Groups(address) {
  let value = address;
  const v4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    value = value.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = value.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

function ipv6Internal(address) {
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [hi, lo] = groups.slice(6);
    return ipv4Internal(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return (
    groups.every((group, index) => group === (index === 7 ? 1 : 0)) || // ::1
    groups.every((group) => group === 0) || // ::
    (groups[0] & 0xfe00) === 0xfc00 || // ULA fc00::/7
    (groups[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
  );
}

/**
 * True for loopback, RFC1918, link-local, CGNAT/tailnet and IPv6 ULA
 * addresses, `.ts.net`, `.local`, `.internal` and `.localhost` names, and
 * unqualified single-label hostnames. Everything else is external.
 */
export function isInternalHost(hostname) {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .replace(/\.$/, '');
  if (!host) return false;
  if (isLoopbackAddress(host)) return true;
  const family = isIP(host);
  if (family === 4) return ipv4Internal(host);
  if (family === 6) return ipv6Internal(host);
  if (!host.includes('.')) return true;
  return ['.ts.net', '.local', '.internal', '.localhost'].some((suffix) => host.endsWith(suffix));
}

function isExternalBackend(backend) {
  // Provider adapters call their fixed cloud origin whatever baseUrl says.
  if (backend?.audioProvider || backend?.videoProvider) return true;
  try {
    return !isInternalHost(new URL(String(backend?.baseUrl ?? '')).hostname);
  } catch {
    return true;
  }
}

/**
 * Whether requests to this backend are redacted. `backends.<id>.redact` wins
 * in either direction; otherwise `security.redactEgress` applies to external
 * backends, except a federated LLooM gateway, which applies its own policy.
 */
export function shouldRedactEgress(config, backendId, backend) {
  if (typeof backend?.redact === 'boolean') return backend.redact;
  if (config?.security?.redactEgress !== true) return false;
  if (backendId && isFederatedGatewayBackend(config, backendId)) return false;
  return isExternalBackend(backend);
}
