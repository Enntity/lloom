#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Build locally; give LLooM an immutable image and ordinary distributed runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function materialize({
  image,
  workerImage = image,
  sourceRevision,
  e3 = false,
  tiny = false,
  nvfp4 = false,
  nvfp4Tiny = false,
  nvfp4Budget = false,
  mxfp8Draft = false,
  draftTp = 2,
  prefillTokens = 7168,
  moeBackend = 'auto',
  e3Policy = 'large',
  e3Trace = false,
  contextTokens,
  kvCacheGiB,
  exl3TempRows = 128
}) {
  if (
    contextTokens !== undefined &&
    (!Number.isInteger(contextTokens) || contextTokens < 4096 || contextTokens > 1048576)
  )
    throw new Error('Context token limit must be an integer in 4096..1048576');
  if (kvCacheGiB !== undefined && (!Number.isInteger(kvCacheGiB) || kvCacheGiB < 1 || kvCacheGiB > 32))
    throw new Error('KV cache budget must be an integer in 1..32 GiB');
  if (nvfp4Tiny && (nvfp4 || e3)) throw new Error('NVFP4 fixture cannot use real-model or E3 options');
  tiny = tiny || nvfp4Tiny;
  if (!['large', 'concurrent'].includes(e3Policy)) throw new Error('Unknown E3 policy');
  if (!e3 && (e3Policy !== 'large' || e3Trace)) throw new Error('E3 policy controls require --e3');
  if (tiny && nvfp4Budget) throw new Error('Full-model comparison budget cannot use a tiny fixture');
  if (tiny && mxfp8Draft) throw new Error('Tiny fixtures have no speculative draft');
  if (![1, 2].includes(draftTp)) throw new Error('Draft TP must be 1 or 2');
  if (!Number.isInteger(prefillTokens) || prefillTokens < 128 || prefillTokens > 32768)
    throw new Error('Prefill token budget must be an integer in 128..32768');
  if (!['auto', 'flashinfer_cutlass', 'humming', 'marlin', 'flashinfer_b12x'].includes(moeBackend))
    throw new Error('Unsupported experimental MoE backend');
  if (moeBackend !== 'auto' && !nvfp4 && !nvfp4Tiny) throw new Error('MoE backend override is for NVFP4 experiments');
  if (!/^sha256:[0-9a-f]{64}$/.test(image || '')) throw new Error('full local image ID required');
  if (!/^sha256:[0-9a-f]{64}$/.test(workerImage || '')) throw new Error('full worker image ID required');
  if (!/^[0-9a-f]{40}$/.test(sourceRevision || '')) throw new Error('full SparkGLM source revision required');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const recipe = JSON.parse(
    await fs.readFile(path.join(root, 'recipes/linux-nvidia-dgx-spark-2x-glm53-flash-exl3-vllm.json'), 'utf8')
  );
  recipe.id = 'linux-nvidia-dgx-spark-2x-sparkglm-exl3';
  recipe.name = 'SparkGLM EXL3 TP2 managed runtime';
  recipe.version = 1;
  recipe.summary =
    'Locally built SparkGLM image, managed by LLooM worker-first with ordinary admission, stop, routing and telemetry. Image must exist with this exact ID on both nodes.';
  recipe.provenance.source = `SparkGLM https://github.com/Enntity/sparkglm at ${sourceRevision}; local head image ${image}; worker image ${workerImage}. Runtime integration is unqualified until the managed gateway gates pass.`;
  recipe.links = [
    { rel: 'upstream', href: `https://github.com/Enntity/sparkglm/tree/${sourceRevision}` },
    ...recipe.links.filter((v) => v.rel !== 'upstream')
  ];
  recipe.backend.name = 'Locally built SparkGLM OpenAI server';
  recipe.hardware.notes = [
    'TP2 worker-first lifecycle belongs to LLooM.',
    'No new kernel or capacity claim is implied by installing this profile.',
    'Preserve local image identity and source qualification on both ranks.'
  ];
  // Explicit start for experiments; installing the profile must not reclaim GPUs.
  recipe.models[0].settings.keepWarm = false;
  for (const member of recipe.models[0].settings.placement.members) {
    const boot = member.runtimeSettings.bootstrap;
    boot.image = member.role === 'worker' ? workerImage : image;
    boot.pull = false;
    // Independent Docker retries cannot reconstruct the peer's NCCL session.
    // LLooM owns retrying the distributed runtime as a pair.
    boot.createArgs = boot.createArgs.map((v, index, args) =>
      String(index > 0 && args[index - 1] === '--restart' ? 'no' : v)
        .replace('backends/glm53-exl3/entrypoint.sh', 'backends/sparkglm/entrypoint.sh')
        .replace('GLM53_MIXED_PREFILL_CHUNK=skip', 'GLM53_MIXED_PREFILL_CHUNK=0')
        .replace('GLM53_SPINWAIT_MS=stock', 'GLM53_SPINWAIT_MS=16')
    );
    boot.createArgs.push(
      '-e',
      'EXL3_FAT_TILE_M=64',
      '-e',
      'EXL3_GROUPED_PREFILL_K4=1',
      '-e',
      'EXL3_DECODE_COOP_K4=1',
      '-e',
      'EXL3_DECODE_COOP_MAX_TOKENS=16',
      '-e',
      'GLM53_MIXED_PREFILL_MAX_WAIT_MS=0'
    );
  }
  if (nvfp4 && (e3 || tiny)) throw new Error('NVFP4 cannot use the EXL3 experiment or dummy fixture');
  if (nvfp4) {
    recipe.id = 'linux-nvidia-dgx-spark-2x-sparkglm-nvfp4';
    recipe.name = 'SparkGLM NVFP4 TP2 experimental runtime';
    const model = recipe.models[0];
    model.name = 'SparkGLM NVFP4 experimental';
    model.model = 'RedHatAI/GLM-5.3-Flash-NVFP4';
    model.gatewayModel = 'sparkglm-nvfp4';
    model.upstreamModel = 'sparkglm-nvfp4';
    model.backendConfig = 'sparkglm-nvfp4';
    model.runtime = 'sparkglm-nvfp4-cluster';
    model.aliases = [];
    model.settings.contextWindow = 65536;
    model.settings.memoryGb = 112;
    const target = recipe.setup.steps.find((v) => v.id === 'download-target');
    Object.assign(target, {
      title: 'Download pinned GLM-5.3 Flash NVFP4 target',
      model: model.model,
      revision: '240131d6a447c8d89acd428c5ddfc85598651744',
      downloadSizeBytes: 197897969933
    });
    recipe.links = recipe.links.map((link) =>
      link.rel === 'model' ? { ...link, href: `https://huggingface.co/${model.model}/tree/${target.revision}` } : link
    );
    recipe.keywords = recipe.keywords.filter((value) => !['exl3', 'tr3'].includes(value));
    recipe.keywords.push('nvfp4', 'compressed-tensors');
    for (const member of model.settings.placement.members) {
      member.runtime = `sparkglm-nvfp4-${member.role}`;
      member.resources.memoryGb = 112;
      member.runtimeSettings.containerName = 'lloom-sparkglm-nvfp4-${nodeId}';
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((v) =>
        String(v)
          .replace(/^MODEL_DIR=.*/, 'MODEL_DIR=/models/RedHatAI--GLM-5.3-Flash-NVFP4')
          .replace(/^SERVED_MODEL_NAME=.*/, 'SERVED_MODEL_NAME=sparkglm-nvfp4')
          .replace(/^MAX_MODEL_LEN=.*/, 'MAX_MODEL_LEN=65536')
      );
      member.runtimeSettings.bootstrap.createArgs.push(
        '-e',
        'QUANTIZATION=compressed-tensors',
        '-e',
        'KV_CACHE_MEMORY_BYTES=8589934592'
      );
    }
  }
  if (nvfp4Budget && !nvfp4) {
    const model = recipe.models[0];
    model.settings.contextWindow = 65536;
    model.settings.memoryGb = 112;
    for (const member of model.settings.placement.members) {
      member.resources.memoryGb = 112;
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((v) =>
        String(v).replace(/^MAX_MODEL_LEN=.*/, 'MAX_MODEL_LEN=65536')
      );
      member.runtimeSettings.bootstrap.createArgs.push('-e', 'KV_CACHE_MEMORY_BYTES=8589934592');
    }
  }
  if (tiny) {
    const fixtureId = nvfp4Tiny ? 'sparkglm-tiny-nvfp4' : 'sparkglm-tiny';
    const fixtureDir = nvfp4Tiny ? 'sparkglm--tinyglm-nvfp4' : 'sparkglm--tinyglm';
    recipe.id = `linux-nvidia-dgx-spark-2x-${fixtureId}`;
    recipe.name = 'SparkGLM synthetic TP2 integration fixture';
    recipe.setup.steps = recipe.setup.steps.filter((v) => v.id === 'check-docker');
    const model = recipe.models[0];
    model.name = 'tinyGLM synthetic integration fixture';
    model.model = nvfp4Tiny ? 'sparkglm/tinyglm-nvfp4' : 'sparkglm/tinyglm';
    model.gatewayModel = fixtureId;
    model.upstreamModel = fixtureId;
    model.backendConfig = fixtureId;
    model.runtime = `${fixtureId}-cluster`;
    model.aliases = [];
    model.input = ['text'];
    model.settings.contextWindow = 32768;
    model.settings.maxOutputTokens = 1024;
    model.settings.memoryGb = 24;
    for (const member of model.settings.placement.members) {
      member.runtime = `${fixtureId}-${member.role}`;
      member.resources.memoryGb = 24;
      member.runtimeSettings.containerName = `lloom-${fixtureId}-` + '${nodeId}';
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((v) =>
        String(v)
          .replace(/^MODEL_DIR=.*/, `MODEL_DIR=/models/${fixtureDir}`)
          .replace(/^SERVED_MODEL_NAME=.*/, `SERVED_MODEL_NAME=${fixtureId}`)
          .replace(/^SPEC_METHOD=.*/, 'SPEC_METHOD=none')
          .replace(/^MAX_MODEL_LEN=.*/, 'MAX_MODEL_LEN=32768')
          .replace(/^GPU_MEMORY_UTILIZATION=.*/, 'GPU_MEMORY_UTILIZATION=0.15')
      );
      member.runtimeSettings.bootstrap.createArgs.push(
        '-e',
        nvfp4Tiny ? 'SPARKGLM_NVFP4_TINY=1' : 'SPARKGLM_TINY_DUMMY=1',
        '-e',
        'LANGUAGE_MODEL_ONLY=1'
      );
      if (nvfp4Tiny) member.runtimeSettings.bootstrap.createArgs.push('-e', 'QUANTIZATION=compressed-tensors');
    }
  }
  if (e3)
    for (const member of recipe.models[0].settings.placement.members) {
      member.runtimeSettings.bootstrap.createArgs.push('-e', 'SPARKGLM_EXL3_E3=1');
      if (e3Policy !== 'large')
        member.runtimeSettings.bootstrap.createArgs.push('-e', `SPARKGLM_EXL3_E3_POLICY=${e3Policy}`);
      if (e3Trace) member.runtimeSettings.bootstrap.createArgs.push('-e', 'SPARKGLM_EXL3_E3_TRACE=1');
    }
  if (mxfp8Draft) {
    const draft = recipe.setup.steps.find((step) => step.id === 'download-dflash2');
    Object.assign(draft, {
      title: 'Download pinned GLM-5.3 Flash MXFP8 DFlash2 draft',
      model: 'local-inference-lab/GLM-5.3-Flash-DFlash2-MXFP8',
      revision: '610aa967a92bfeb97e3d848dcb8693553e8b6a55'
    });
    // The original BF16 byte estimate must not describe the quantized checkpoint.
    delete draft.downloadSizeBytes;
    recipe.links = recipe.links.map((link) =>
      link.rel === 'draft-model'
        ? { ...link, href: `https://huggingface.co/${draft.model}/tree/${draft.revision}` }
        : link
    );
  }
  for (const model of recipe.models) {
    if (![32, 64, 128].includes(exl3TempRows)) throw new Error('EXL3 temp rows must be 32, 64 or 128');
    if ((nvfp4 || nvfp4Tiny) && exl3TempRows !== 128) throw new Error('EXL3 temp rows do not apply to NVFP4');
    if (contextTokens !== undefined) model.settings.contextWindow = contextTokens;
    for (const member of model.settings.placement.members) {
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((value) => {
        let result = String(value)
          .replace(/^EXL3_TEMP_ROWS_FUSED=.*/, `EXL3_TEMP_ROWS_FUSED=${exl3TempRows}`)
          .replace(/^DFLASH_DRAFT_TP=.*/, `DFLASH_DRAFT_TP=${draftTp}`)
          .replace(/^MAX_NUM_BATCHED_TOKENS=.*/, `MAX_NUM_BATCHED_TOKENS=${prefillTokens}`);
        if (contextTokens !== undefined) result = result.replace(/^MAX_MODEL_LEN=.*/, `MAX_MODEL_LEN=${contextTokens}`);
        if (mxfp8Draft)
          result = result.replace(
            /^DFLASH_MODEL_DIR=.*/,
            'DFLASH_MODEL_DIR=/models/local-inference-lab--GLM-5.3-Flash-DFlash2-MXFP8'
          );
        return result;
      });
      if (kvCacheGiB !== undefined) {
        const args = member.runtimeSettings.bootstrap.createArgs;
        const existing = args.findIndex((v) => String(v).startsWith('KV_CACHE_MEMORY_BYTES='));
        const setting = `KV_CACHE_MEMORY_BYTES=${kvCacheGiB * 1073741824}`;
        if (existing >= 0) args[existing] = setting;
        else args.push('-e', setting);
      }
      if (mxfp8Draft) member.runtimeSettings.bootstrap.createArgs.push('-e', 'SPARKGLM_MXFP8_DRAFT=1');
      if (moeBackend !== 'auto') member.runtimeSettings.bootstrap.createArgs.push('-e', `MOE_BACKEND=${moeBackend}`);
      if (member.runtimeSettings.warmup?.body) {
        member.runtimeSettings.warmup.body.model = model.upstreamModel;
      }
    }
  }
  return recipe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (k) => args[args.indexOf(k) + 1];
  try {
    const recipe = await materialize({
      exl3TempRows: args.includes('--exl3-temp-rows') ? Number(value('--exl3-temp-rows')) : 128,
      contextTokens: args.includes('--context-tokens') ? Number(value('--context-tokens')) : undefined,
      kvCacheGiB: args.includes('--kv-cache-gib') ? Number(value('--kv-cache-gib')) : undefined,
      image: value('--image-id'),
      workerImage: args.includes('--worker-image-id') ? value('--worker-image-id') : undefined,
      sourceRevision: value('--source-revision'),
      e3: args.includes('--e3'),
      tiny: args.includes('--tiny'),
      nvfp4: args.includes('--nvfp4'),
      nvfp4Tiny: args.includes('--nvfp4-tiny'),
      nvfp4Budget: args.includes('--nvfp4-budget'),
      mxfp8Draft: args.includes('--mxfp8-draft'),
      draftTp: args.includes('--draft-tp') ? Number(value('--draft-tp')) : 2,
      prefillTokens: args.includes('--prefill-tokens') ? Number(value('--prefill-tokens')) : 7168,
      moeBackend: args.includes('--moe-backend') ? value('--moe-backend') : 'auto',
      e3Policy: args.includes('--e3-policy') ? value('--e3-policy') : 'large',
      e3Trace: args.includes('--e3-trace')
    });
    if (!args.includes('--output')) throw new Error('--output required');
    await fs.writeFile(value('--output'), JSON.stringify(recipe, null, 2) + '\n');
    console.log(
      JSON.stringify({
        recipe: recipe.id,
        image: recipe.models[0].settings.placement.members[0].runtimeSettings.bootstrap.image,
        output: value('--output')
      })
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
