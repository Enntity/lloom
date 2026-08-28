import assert from 'node:assert/strict';
import {
  QWEN_VLLM_THINKING_BUDGETS,
  isOpenRouter,
  isQwen38FlashNextSglang,
  isQwenSglang,
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

const qwen38Sglang = {
  model: {
    id: 'qwen3.8-flash-next',
    upstreamModel: 'qwen3.8-flash-next'
  },
  backend: { id: 'qwen38-sglang', type: 'openai' },
  runtime: {
    adapter: 'docker',
    recipe: { id: 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang' },
    behaviorOverrides: {
      reasoningBudget: {
        kind: 'sglang-custom-logit-processor',
        processor: '{"callable":"test-processor"}',
        budgets: QWEN_VLLM_THINKING_BUDGETS
      }
    }
  }
};

const qwen38NoThinking = translateReasoningEffortForBackend({ reasoning_effort: 'none' }, qwen38Sglang);
assert.equal(qwen38NoThinking.reasoning_effort, undefined);
assert.equal(qwen38NoThinking.chat_template_kwargs.enable_thinking, false);

const qwen38Thinking = translateReasoningEffortForBackend({ reasoning_effort: 'low' }, qwen38Sglang);
assert.equal(qwen38Thinking.reasoning_effort, undefined);
assert.equal(qwen38Thinking.chat_template_kwargs.enable_thinking, true);
assert.equal(qwen38Thinking.thinking_token_budget, undefined);
assert.equal(qwen38Thinking.custom_logit_processor, '{"callable":"test-processor"}');
assert.deepEqual(qwen38Thinking.custom_params, { thinking_budget: QWEN_VLLM_THINKING_BUDGETS.low });

const qwen38ExplicitBudget = translateReasoningEffortForBackend(
  {
    reasoning_effort: 'high',
    custom_logit_processor: '{"callable":"override"}',
    custom_params: { thinking_budget: 64, marker: 'kept' }
  },
  qwen38Sglang
);
assert.equal(qwen38ExplicitBudget.custom_logit_processor, '{"callable":"override"}');
assert.deepEqual(qwen38ExplicitBudget.custom_params, { thinking_budget: 64, marker: 'kept' });

const qwen38ExplicitOff = translateReasoningEffortForBackend(
  { reasoning_effort: 'high', chat_template_kwargs: { enable_thinking: false } },
  qwen38Sglang
);
assert.equal(qwen38ExplicitOff.custom_logit_processor, undefined);
assert.equal(qwen38ExplicitOff.custom_params, undefined);

const qwen38Unprofiled = {
  ...qwen38Sglang,
  runtime: { adapter: 'docker', recipe: qwen38Sglang.runtime.recipe }
};
const qwen38UnprofiledThinking = translateReasoningEffortForBackend({ reasoning_effort: 'low' }, qwen38Unprofiled);
assert.equal(qwen38UnprofiledThinking.custom_logit_processor, undefined);
assert.equal(qwen38UnprofiledThinking.chat_template_kwargs.enable_thinking, true);
assert.equal(qwen38UnprofiledThinking.chat_template_kwargs.reasoning_effort, 'low');

const qwen38UnprofiledMedium = translateReasoningEffortForBackend({ reasoning_effort: 'medium' }, qwen38Unprofiled);
assert.equal(qwen38UnprofiledMedium.chat_template_kwargs.reasoning_effort, 'medium');

const qwen38UnprofiledHigh = translateReasoningEffortForBackend({ reasoning_effort: 'high' }, qwen38Unprofiled);
assert.equal(qwen38UnprofiledHigh.chat_template_kwargs.reasoning_effort, 'xhigh');

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

const openRouter = {
  model: { id: 'deepseek/deepseek-v4-flash-0731', upstreamModel: 'deepseek/deepseek-v4-flash-0731' },
  backend: { id: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }
};

{
  assert.equal(isOpenRouter(openRouter), true);
  const translated = translateReasoningEffortForBackend(
    {
      model: openRouter.model.id,
      reasoning_effort: 'none'
    },
    openRouter
  );
  assert.equal(translated.reasoning_effort, undefined);
  assert.deepEqual(translated.reasoning, { effort: 'none', exclude: true });

  const explicit = translateReasoningEffortForBackend(
    {
      model: openRouter.model.id,
      reasoning: { effort: 'none', exclude: false }
    },
    openRouter
  );
  assert.deepEqual(explicit.reasoning, { effort: 'none', exclude: false });
}

{
  assert.equal(isQwenVllm(qwenVllm), true);
  assert.equal(isQwenVllm({ ...qwenVllm, model: { id: 'meta-llama/Llama-3.3-70B' } }), false);
  assert.equal(isQwenSglang(qwen38Sglang), true);
  assert.equal(isQwen38FlashNextSglang(qwen38Sglang), true);
  assert.equal(isQwenVllm(qwen38Sglang), false);
  assert.equal(isQwen38FlashNextSglang(qwenVllm), false);
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
