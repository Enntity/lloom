import assert from 'node:assert/strict';
import {
  QWEN_VLLM_THINKING_BUDGETS,
  isQwenVllm,
  responsesToOpenAIChat,
  translateReasoningEffortForBackend
} from '../src/protocol/index.mjs';

const qwenVllm = {
  model: {
    id: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
    upstreamModel: 'unsloth/Qwen3.6-35B-A3B-NVFP4'
  },
  backend: { id: 'spark-vllm-8000', type: 'openai' },
  runtime: { bootstrap: { image: 'vllm/vllm-openai:v0.24.0' } }
};

const qwenVllmWithTemplateProfile = {
  ...qwenVllm,
  runtime: {
    ...qwenVllm.runtime,
    behaviorOverrides: {
      chatTemplate: 'qwen-fixed-v21.3',
      chatTemplateKwargs: {
        auto_disable_thinking_with_tools: false,
        preserve_thinking: true
      }
    }
  }
};

{
  assert.equal(isQwenVllm(qwenVllm), true);
  assert.equal(isQwenVllm({ ...qwenVllm, model: { id: 'meta-llama/Llama-3.3-70B' } }), false);
}

{
  const translated = translateReasoningEffortForBackend(
    {
      model: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
      reasoning_effort: 'minimal',
      chat_template_kwargs: { preserve_thinking: true }
    },
    qwenVllm
  );
  assert.equal(translated.reasoning_effort, undefined);
  assert.equal(translated.thinking_token_budget, QWEN_VLLM_THINKING_BUDGETS.minimal);
  assert.deepEqual(translated.chat_template_kwargs, { preserve_thinking: true, enable_thinking: true });
}

{
  for (const [effort, budget] of Object.entries(QWEN_VLLM_THINKING_BUDGETS)) {
    const translated = translateReasoningEffortForBackend({ reasoning_effort: effort }, qwenVllm);
    assert.equal(translated.thinking_token_budget, budget, `${effort} maps to its native budget`);
  }
}

{
  const disabled = translateReasoningEffortForBackend({ reasoning_effort: 'none' }, qwenVllm);
  assert.equal(disabled.thinking_token_budget, undefined);
  assert.equal(disabled.chat_template_kwargs.enable_thinking, false);

  const automatic = translateReasoningEffortForBackend({ reasoning_effort: 'auto' }, qwenVllm);
  assert.equal(automatic.thinking_token_budget, undefined);
  assert.equal(automatic.chat_template_kwargs, undefined);
}

{
  const explicitBudget = translateReasoningEffortForBackend(
    { reasoning_effort: 'minimal', thinking_token_budget: 64 },
    qwenVllm
  );
  assert.equal(explicitBudget.thinking_token_budget, 64);
  assert.equal(explicitBudget.chat_template_kwargs.enable_thinking, true);

  const explicitOff = translateReasoningEffortForBackend(
    { reasoning_effort: 'high', chat_template_kwargs: { enable_thinking: false } },
    qwenVllm
  );
  assert.equal(explicitOff.thinking_token_budget, undefined);
  assert.equal(explicitOff.chat_template_kwargs.enable_thinking, false);
}

{
  const untouched = { reasoning_effort: 'minimal', model: 'llama' };
  assert.strictEqual(translateReasoningEffortForBackend(untouched, { model: { id: 'llama' } }), untouched);
}

{
  const translated = translateReasoningEffortForBackend(
    {
      model: 'unsloth/Qwen3.6-27B-NVFP4',
      reasoning_effort: 'low',
      chat_template_kwargs: { preserve_thinking: false }
    },
    qwenVllmWithTemplateProfile
  );
  assert.equal(translated.reasoning_effort, undefined);
  assert.equal(translated.thinking_token_budget, QWEN_VLLM_THINKING_BUDGETS.low);
  assert.deepEqual(translated.chat_template_kwargs, {
    auto_disable_thinking_with_tools: false,
    preserve_thinking: false,
    enable_thinking: true
  });

  const withoutEffort = translateReasoningEffortForBackend(
    { model: 'unsloth/Qwen3.6-27B-NVFP4' },
    qwenVllmWithTemplateProfile
  );
  assert.deepEqual(withoutEffort.chat_template_kwargs, {
    auto_disable_thinking_with_tools: false,
    preserve_thinking: true
  });
}

{
  const translated = responsesToOpenAIChat(
    {
      model: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
      input: 'What is 17 times 23?',
      reasoning: { effort: 'low' }
    },
    qwenVllm
  );
  assert.equal(translated.reasoning_effort, undefined);
  assert.equal(translated.thinking_token_budget, QWEN_VLLM_THINKING_BUDGETS.low);
  assert.equal(translated.chat_template_kwargs.enable_thinking, true);
}

console.log('reasoning-effort tests passed');
