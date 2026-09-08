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
  nvfp4 = false
}) {
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
    boot.createArgs = boot.createArgs.map((v) =>
      String(v)
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
    model.settings.contextWindow = 262144;
    model.settings.memoryGb = 112;
    const target = recipe.setup.steps.find((v) => v.id === 'download-target');
    Object.assign(target, {
      model: model.model,
      revision: '240131d6a447c8d89acd428c5ddfc85598651744',
      downloadSizeBytes: 197897969933
    });
    for (const member of model.settings.placement.members) {
      member.runtime = `sparkglm-nvfp4-${member.role}`;
      member.resources.memoryGb = 112;
      member.runtimeSettings.containerName = 'lloom-sparkglm-nvfp4-${nodeId}';
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((v) =>
        String(v)
          .replace(/^MODEL_DIR=.*/, 'MODEL_DIR=/models/RedHatAI--GLM-5.3-Flash-NVFP4')
          .replace(/^SERVED_MODEL_NAME=.*/, 'SERVED_MODEL_NAME=sparkglm-nvfp4')
          .replace(/^MAX_MODEL_LEN=.*/, 'MAX_MODEL_LEN=262144')
      );
      member.runtimeSettings.bootstrap.createArgs.push(
        '-e',
        'QUANTIZATION=compressed-tensors',
        '-e',
        'KV_CACHE_MEMORY_BYTES=8589934592'
      );
    }
  }
  if (tiny) {
    recipe.id = 'linux-nvidia-dgx-spark-2x-sparkglm-tiny';
    recipe.name = 'SparkGLM synthetic TP2 integration fixture';
    recipe.setup.steps = recipe.setup.steps.filter((v) => v.id === 'check-docker');
    const model = recipe.models[0];
    model.name = 'tinyGLM synthetic integration fixture';
    model.model = 'sparkglm/tinyglm';
    model.gatewayModel = 'sparkglm-tiny';
    model.upstreamModel = 'sparkglm-tiny';
    model.backendConfig = 'sparkglm-tiny';
    model.runtime = 'sparkglm-tiny-cluster';
    model.aliases = [];
    model.input = ['text'];
    model.settings.contextWindow = 32768;
    model.settings.maxOutputTokens = 1024;
    model.settings.memoryGb = 24;
    for (const member of model.settings.placement.members) {
      member.runtime = `sparkglm-tiny-${member.role}`;
      member.resources.memoryGb = 24;
      member.runtimeSettings.containerName = 'lloom-sparkglm-tiny-${nodeId}';
      member.runtimeSettings.bootstrap.createArgs = member.runtimeSettings.bootstrap.createArgs.map((v) =>
        String(v)
          .replace(/^MODEL_DIR=.*/, 'MODEL_DIR=/models/sparkglm--tinyglm')
          .replace(/^SERVED_MODEL_NAME=.*/, 'SERVED_MODEL_NAME=sparkglm-tiny')
          .replace(/^SPEC_METHOD=.*/, 'SPEC_METHOD=none')
          .replace(/^MAX_MODEL_LEN=.*/, 'MAX_MODEL_LEN=32768')
          .replace(/^GPU_MEMORY_UTILIZATION=.*/, 'GPU_MEMORY_UTILIZATION=0.15')
      );
      member.runtimeSettings.bootstrap.createArgs.push('-e', 'SPARKGLM_TINY_DUMMY=1', '-e', 'LANGUAGE_MODEL_ONLY=1');
    }
  }
  if (e3)
    for (const member of recipe.models[0].settings.placement.members) {
      member.runtimeSettings.bootstrap.createArgs.push('-e', 'SPARKGLM_EXL3_E3=1');
    }
  return recipe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (k) => args[args.indexOf(k) + 1];
  try {
    const recipe = await materialize({
      image: value('--image-id'),
      workerImage: args.includes('--worker-image-id') ? value('--worker-image-id') : undefined,
      sourceRevision: value('--source-revision'),
      e3: args.includes('--e3'),
      tiny: args.includes('--tiny'),
      nvfp4: args.includes('--nvfp4')
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
