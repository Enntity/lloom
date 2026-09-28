import assert from 'node:assert/strict';
import {
  applyOpenRouterProviderPolicy,
  isOpenRouterBackend,
  normalizeOpenRouterProviderPolicy
} from '../src/protocol/openrouter-provider.mjs';

// ---------------------------------------------------------------------------
// Pure policy unit coverage
// ---------------------------------------------------------------------------

const openRouterBackend = (extra = {}) => ({
  id: 'openrouter-lane',
  type: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  ...extra
});

function testLookalikeHosts() {
  assert.equal(isOpenRouterBackend(openRouterBackend()), true);
  assert.equal(isOpenRouterBackend({ baseUrl: 'https://openrouter.ai/api/v1' }), true);
  for (const baseUrl of [
    'https://openrouter.ai.evil.example/api/v1',
    'https://notopenrouter.ai/api/v1',
    'https://openrouter.ai.example.com/api/v1',
    'https://api.openrouter.ai/api/v1',
    'http://127.0.0.1:8200/v1',
    'not a url',
    '',
    undefined
  ]) {
    assert.equal(isOpenRouterBackend({ baseUrl }), false, `expected lookalike to be rejected: ${baseUrl}`);
  }
}

function testNoConfigLeavesBodyUntouched() {
  const body = {
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    provider: { order: ['together'], allow_fallbacks: true }
  };
  const frozen = JSON.parse(JSON.stringify(body));
  // No policy key at all.
  assert.equal(applyOpenRouterProviderPolicy(body, openRouterBackend()), body);
  // Policy explicitly null is "not configured", not malformed.
  assert.equal(applyOpenRouterProviderPolicy(body, openRouterBackend({ openrouterProvider: null })), body);
  // Non-OpenRouter host is untouched. A policy there is never enforced, so a
  // plain (not-openrouter) backend must not be rejected for carrying one.
  const local = { id: 'local', baseUrl: 'http://127.0.0.1:8201/v1', openrouterProvider: { only: ['z-ai'] } };
  assert.equal(applyOpenRouterProviderPolicy(body, local), body);
  assert.deepEqual(body, frozen);
}

function testValidPolicyEnforced() {
  const body = { model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] };
  const applied = applyOpenRouterProviderPolicy(body, openRouterBackend({ openrouterProvider: { only: ['z-ai'] } }));
  assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: false });
  // Default allow_fallbacks is false (fail closed) when omitted.
  assert.equal(applied.provider.allow_fallbacks, false);
  // Original body is not mutated.
  assert.equal(body.provider, undefined);

  const explicit = applyOpenRouterProviderPolicy(
    body,
    openRouterBackend({ openrouterProvider: { only: ['z-ai', 'z-ai-intl'], allow_fallbacks: true } })
  );
  assert.deepEqual(explicit.provider, { only: ['z-ai', 'z-ai-intl'], allow_fallbacks: true });

  // Whitespace is trimmed and surrounding body fields are preserved.
  const trimmed = applyOpenRouterProviderPolicy(
    { model: 'z-ai/glm-5.2', temperature: 0.4, provider: { order: ['x'] } },
    openRouterBackend({ openrouterProvider: { only: [' z-ai '] } })
  );
  assert.deepEqual(trimmed.provider.only, ['z-ai']);
  assert.equal(trimmed.temperature, 0.4);
  // Caller provider fields survive alongside the enforced keys.
  assert.deepEqual(trimmed.provider.order, ['x']);
}

function testCallerOverrideAttemptsLose() {
  const backend = openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: false } });
  const cases = [
    { provider: { only: ['openai'], allow_fallbacks: true } },
    { provider: { allow_fallbacks: true } },
    { provider: { only: [] } },
    { provider: { only: ['any'] } }
  ];
  for (const extra of cases) {
    const applied = applyOpenRouterProviderPolicy({ model: 'm', messages: [], ...extra }, backend);
    assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: false }, JSON.stringify(extra));
  }

  const permissive = openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: true } });
  const applied = applyOpenRouterProviderPolicy({ provider: { allow_fallbacks: false } }, permissive);
  assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: true });
}

function testNonObjectBodyUntouched() {
  const backend = openRouterBackend({ openrouterProvider: { only: ['z-ai'] } });
  for (const body of [null, undefined, 'not-an-object', 42, ['array']]) {
    assert.equal(applyOpenRouterProviderPolicy(body, backend), body);
  }
}

function testMalformedPoliciesThrow() {
  const base = { id: 'openrouter-lane', baseUrl: 'https://openrouter.ai/api/v1' };
  const malformed = [
    {}, // only is required
    { only: [] },
    { only: 'z-ai' },
    { only: ['z-ai', ''] },
    { only: ['z-ai', '   '] },
    { only: [null] },
    { only: ['z-ai'], allow_fallbacks: 'no' },
    { only: ['z-ai'], allow_fallbacks: 1 },
    { only: ['z-ai'], order: ['x'] }, // unknown key
    { only: ['z-ai'], allow_fallbacks: false, ignore: ['a'] },
    { only: ['z-ai'], dataCollection: 'deny' },
    'z-ai',
    ['z-ai'],
    42
  ];
  for (const openrouterProvider of malformed) {
    assert.throws(
      () => normalizeOpenRouterProviderPolicy(openrouterProvider, { backendId: 'openrouter-lane' }),
      /openrouterProvider/,
      `expected malformed policy to throw: ${JSON.stringify(openrouterProvider)}`
    );
    assert.throws(
      () => applyOpenRouterProviderPolicy({ model: 'm' }, { ...base, openrouterProvider }),
      /openrouterProvider/,
      `expected apply to fail closed for: ${JSON.stringify(openrouterProvider)}`
    );
  }
  // No configured value (undefined/null) is not malformed.
  assert.equal(normalizeOpenRouterProviderPolicy(undefined), null);
  assert.equal(normalizeOpenRouterProviderPolicy(null), null);
}

// ---------------------------------------------------------------------------
// Audio gateway integration is covered in audio-providers.test.mjs.

// ---------------------------------------------------------------------------

testLookalikeHosts();
testNoConfigLeavesBodyUntouched();
testValidPolicyEnforced();
testCallerOverrideAttemptsLose();
testNonObjectBodyUntouched();
testMalformedPoliciesThrow();

console.log('openrouter-provider: ok');
