import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend,
  planBackendCatalog,
  validateBackendCatalog
} from '../src/backend-catalog.mjs';
import {
  BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  benchmarkOverview,
  loadBenchmarkEvidence,
  submitBenchmarkSuites,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence,
  validateBenchmarkSubmissionResponse,
  validateBenchmarkSuite
} from '../src/benchmarks.mjs';
import { applyBootstrap, createBootstrapPlan } from '../src/bootstrap.mjs';
import {
  applyIntegrationArtifacts,
  buildClientIntegrationManifest,
  buildIntegrationArtifacts,
  CLIENT_INTEGRATIONS_MEDIA_TYPE,
  createClientIntegrationStatus,
  validateClientIntegrationManifest,
  writeGeneratedIntegrationArtifacts
} from '../src/client-integrations.mjs';
import {
  applyCommunityRecommendations,
  createCommunityPlan,
  isLoopbackCommunityHost,
  localHostServeCommand
} from '../src/community-client.mjs';
import { createDoctorReport } from '../src/doctor.mjs';
import { createLloomHostServer } from '../src/host-server.mjs';
import { applyInit, createInitPlan, deriveUserConfig } from '../src/init.mjs';
import { applyBackend, applyRecipe, readInstallState } from '../src/installer.mjs';
import {
  ERROR_RESPONSE_MEDIA_TYPE,
  INTERCHANGE_REGISTRY_MEDIA_TYPE,
  SIGNING_KEYS_MEDIA_TYPE,
  VALIDATION_REPORT_MEDIA_TYPE,
  VALIDATION_REPORT_SCHEMA,
  createErrorResponse,
  createInterchangeRegistry,
  createInterchangeValidationReport,
  validateInterchangeDocument
} from '../src/interchange.mjs';
import {
  MACHINE_PROFILE_MEDIA_TYPE,
  normalizeMachineProfile,
  profileMachine,
  rankRecipes,
  RECOMMENDATION_REQUEST_MEDIA_TYPE,
  RECOMMENDATION_RESPONSE_MEDIA_TYPE,
  validateMachineProfile,
  validateRecommendationResponse
} from '../src/machine-profile.mjs';
import {
  applyModelImport,
  applyModelImportGo,
  createModelImportPlan,
  inferBackend,
  normalizeModelReference
} from '../src/model-intake.mjs';
import { applyModelRemoval, createModelRemovalPlan } from '../src/model-removal.mjs';
import { applyOnboarding, createOnboardingPlan } from '../src/onboarding.mjs';
import { writeRecipePackExport } from '../src/recipe-pack-export.mjs';
import {
  RECIPE_PACK_MEDIA_TYPE,
  RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  applyRecipePack,
  createRecipePackSignature,
  createRecipePackPlan,
  submitRecipePack,
  validateRecipePackSubmissionResponse
} from '../src/recipe-pack.mjs';
import { buildRecipeIndexReport, loadRecipeIndex, validateRecipeIndex } from '../src/recipe-index.mjs';
import { defaultUserModelRoot, defaultUserSessionCacheRoot, loadConfig } from '../src/config.mjs';
import { runCommand } from '../src/process-control.mjs';
import { createRegistry } from '../src/registry.mjs';
import { loadRecipeById, loadRecipes, planRecipe } from '../src/recipes.mjs';
import { RuntimeManager, dockerCreateArgs, effectiveRuntimeArgs } from '../src/runtime-manager.mjs';
import { applyRuntimePolicyPlan } from '../src/runtime-policy.mjs';
import { createLloomServer } from '../src/server.mjs';
import { applySetup, createSetupPlan } from '../src/setup.mjs';
import { createSetupStatus } from '../src/setup-status.mjs';

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

async function tryListen(server, host = '127.0.0.1', port = 0) {
  try {
    await listen(server, host, port);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
    console.warn(`skipping HTTP listener smoke: ${error.code}`);
    return false;
  }
}

async function allocatePort() {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const listened = await tryListen(server);
  if (!listened) return null;
  const { port } = server.address();
  await closeServer(server);
  return port;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function addSyntheticWrongKindChatModel(config, backendId) {
  const id = `synthetic-chat-for-${backendId}`;
  config.models.push({
    id,
    name: 'Synthetic Wrong Kind Chat',
    backend: backendId,
    upstreamModel: 'unused-chat-model',
    kind: 'chat',
    input: ['text'],
    output: ['text'],
    capabilities: ['chat'],
    advertise: true
  });
  return id;
}

function communityOnlyConfig(baseConfig) {
  const next = structuredClone(baseConfig);
  next.defaults = {};
  next.backends = {};
  next.runtimes = {};
  next.models = [];
  next.aliases = {};
  next.clientCatalog = {
    providerId: 'local-llm',
    providerName: 'LLooM Local',
    includeAliases: false,
    modelOrder: []
  };
  return next;
}

const config = await loadConfig();
assert.equal(config.community.hostUrl, 'http://127.0.0.1:8110');
assert.equal(config.community.recipeFeedPath, '/v1/recipe-packs/recommended');
assert.equal(config.community.signingKeysPath, '/v1/keys');
assert.equal(config.community.trustHostKeys, true);
assert.equal(config.community.submissionPath, '/v1/benchmarks');
assert.equal(config.community.recipePackSubmissionPath, '/v1/recipe-packs');
assert.equal(config.community.requireSignedPacks, true);
assert.equal(config.community.autoStartLocalHost, true);
assert.equal(config.community.localHostStartupTimeoutMs, 5000);
assert.deepEqual(config.community.workloads, ['agentic-coding']);
assert.deepEqual(config.community.capabilities, ['tools', 'reasoning', 'long-context']);
assert.deepEqual(config.community.tags, []);
assert.equal(config.communityHost.indexPath, 'community/recipes/index.json');
assert.equal(config.communityHost.recipesRoot, 'community/recipes');
assert.equal(config.communityHost.benchmarksRoot, 'community/benchmarks');
assert.equal(config.communityHost.backendCatalogPath, 'backends/catalog.json');
assert.equal(config.communityHost.publisher, 'lloom-dev-host');
assert.equal(config.communityHost.keyId, 'lloom-dev-seed');
assert.equal(config.communityHost.privateKeyPath, 'community/keys/lloom-dev-signing-private.pem');
assert.equal(config.communityHost.publicKeyPath, 'community/keys/lloom-dev-signing-public.pem');
const defaultRegistry = createRegistry(config);
assert.deepEqual(
  defaultRegistry.clientModels({ kinds: ['chat'] }).map((model) => model.id),
  ['Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16', 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed']
);
assert.throws(() => defaultRegistry.resolve('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'), /unknown local model/);
const localCommunityConfig = await loadConfig(undefined, {
  env: {
    ...process.env,
    LLOOM_COMMUNITY_HOST_URL: 'https://community.example',
    LLOOM_COMMUNITY_REQUIRE_SIGNED_PACKS: 'true'
  }
});
assert.equal(localCommunityConfig.community.hostUrl, 'https://community.example');
assert.equal(localCommunityConfig.community.requireSignedPacks, true);
assert.equal(isLoopbackCommunityHost('http://127.0.0.1:8110'), true);
assert.equal(isLoopbackCommunityHost('http://localhost:8110'), true);
assert.equal(isLoopbackCommunityHost('http://localhost'), false);
assert.equal(isLoopbackCommunityHost('https://community.example'), false);
const defaultLocalHostCommand = localHostServeCommand(config, {
  hostUrl: 'http://127.0.0.1:8110'
});
assert(defaultLocalHostCommand.args.includes(path.join(process.cwd(), 'community', 'recipes', 'index.json')));
assert(defaultLocalHostCommand.args.includes(path.join(process.cwd(), 'community', 'recipes')));
assert(defaultLocalHostCommand.args.includes(path.join(process.cwd(), 'community', 'benchmarks')));
const localHostCommand = localHostServeCommand(config, {
  hostUrl: 'http://127.0.0.1:8110',
  indexPath: 'recipes/index.json',
  recipesRoot: 'recipes',
  benchmarksRoot: 'benchmarks/community',
  backendCatalogPath: 'backends/catalog.json'
});
assert.equal(localHostCommand.args[0], path.join(process.cwd(), 'bin', 'lloom-host.mjs'));
assert(localHostCommand.args.includes('--port'));
assert(localHostCommand.args.includes('8110'));
assert(localHostCommand.args.includes('--backend-catalog'));
const localHostCommandWithHostedCatalog = localHostServeCommand(config, {
  hostUrl: 'http://127.0.0.1:8110',
  backendCatalogPath: 'http://127.0.0.1:8110/v1/backends/catalog'
});
assert(localHostCommandWithHostedCatalog.args.includes(path.join(process.cwd(), 'backends', 'catalog.json')));
assert(
  !localHostCommandWithHostedCatalog.args.some((arg) => arg.includes('http://127.0.0.1:8110/v1/backends/catalog'))
);
const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
assert.equal(packageJson.private, false);
assert.deepEqual(packageJson.bin, {
  lloom: 'bin/lloom.mjs',
  'lloom-host': 'bin/lloom-host.mjs'
});
assert(packageJson.files.includes('community/recipes/'));
assert(packageJson.files.includes('community/benchmarks/'));
assert(packageJson.files.includes('community/keys/lloom-dev-signing-public.pem'));
assert(!packageJson.files.includes('community/'));
assert(!packageJson.files.includes('community/keys/lloom-dev-signing-private.pem'));
assert(packageJson.keywords.includes('local-llm'));
assert(packageJson.keywords.includes('ai-gateway'));
assert(packageJson.files.includes('src/'));
assert(packageJson.files.includes('schemas/'));
assert(!packageJson.files.includes('data/'));
assert(!packageJson.files.includes('logs/'));
const gitignore = await fs.readFile(path.join(process.cwd(), '.gitignore'), 'utf8');
assert(gitignore.includes('community/keys/*private*.pem'));
assert(gitignore.includes('logs/'));
assert(gitignore.includes('.lloom/'));
const schemaIds = [
  'https://lloom.dev/schemas/common.v1.schema.json',
  'https://lloom.dev/schemas/interchange-registry.v1.schema.json',
  'https://lloom.dev/schemas/backend-catalog.v1.schema.json',
  'https://lloom.dev/schemas/client-integrations.v1.schema.json',
  'https://lloom.dev/schemas/machine-profile.v1.schema.json',
  'https://lloom.dev/schemas/recommendation-request.v1.schema.json',
  'https://lloom.dev/schemas/recommendation-response.v1.schema.json',
  'https://lloom.dev/schemas/recipe.v1.schema.json',
  'https://lloom.dev/schemas/recipe-index.v1.schema.json',
  'https://lloom.dev/schemas/benchmark-suite.v1.schema.json',
  'https://lloom.dev/schemas/benchmark-submission-response.v1.schema.json',
  'https://lloom.dev/schemas/recipe-pack.v1.schema.json',
  'https://lloom.dev/schemas/recipe-pack-submission-response.v1.schema.json',
  'https://lloom.dev/schemas/error-response.v1.schema.json',
  'https://lloom.dev/schemas/validation-report.v1.schema.json'
];
for (const schemaId of schemaIds) {
  const fileName = schemaId.split('/').at(-1);
  const schema = JSON.parse(await fs.readFile(path.join(process.cwd(), 'schemas', fileName), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, schemaId);
  assert.equal(schema.type, 'object');
  if (schemaId === 'https://lloom.dev/schemas/recipe.v1.schema.json') {
    const modelProperties = schema.properties.models.items.properties;
    assert(modelProperties.input.items.enum.includes('image'));
    assert(modelProperties.output.items.enum.includes('embedding'));
    assert(modelProperties.settings.properties.contextWindow);
    assert(modelProperties.settings.properties.maxActiveRequests);
    assert(modelProperties.settings.properties.runtime.properties.command);
    assert(modelProperties.settings.properties.runtime.properties.args);
    assert(modelProperties.settings.properties.sessionCacheMode.enum.includes('write-only'));
    assert(modelProperties.observed.properties.firstContentMs);
    assert(modelProperties.observed.properties.decodeTokensPerSecond);
  }
}
const registryConfig = structuredClone(config);
registryConfig.runtimes['mtplx-qwen36-27b-speed'].enabled = true;
registryConfig.runtimes['mtplx-qwen36-35b-a3b-speed-fp16'].enabled = true;
registryConfig.runtimes['mlx-audio'].enabled = true;
const registry = createRegistry(registryConfig);
const integrationManifest = buildClientIntegrationManifest(registryConfig, registry.clientModels({ kinds: ['chat'] }));
assert.deepEqual(validateClientIntegrationManifest(integrationManifest), []);
assert.equal(integrationManifest.$schema, 'https://lloom.dev/schemas/client-integrations.v1.schema.json');
assert.equal(integrationManifest.provider.gatewayUrl, 'http://127.0.0.1:8100');
assert.equal(integrationManifest.provider.openAIBaseUrl, 'http://127.0.0.1:8100/v1');
assert.equal(integrationManifest.provider.anthropicBaseUrl, 'http://127.0.0.1:8100');
assert.equal(integrationManifest.provider.endpoints.responses, 'http://127.0.0.1:8100/v1/responses');
assert.equal(integrationManifest.provider.features.streamingUsage, true);
assert(integrationManifest.clients.some((client) => client.id === 'omp'));
assert(integrationManifest.clients.some((client) => client.id === 'codex'));
const integrationManifestValidation = await validateInterchangeDocument(integrationManifest, config);
assert.equal(integrationManifestValidation.ok, true);
assert.equal(integrationManifestValidation.kind, 'clientIntegrations');
assert.equal(integrationManifestValidation.mediaType, CLIENT_INTEGRATIONS_MEDIA_TYPE);
assert.deepEqual(integrationManifestValidation.conformanceWarnings, []);
const backendCatalog = await loadBackendCatalog();
assert.deepEqual(validateBackendCatalog(backendCatalog), []);
const backendCatalogValidation = await createInterchangeValidationReport(
  path.join(process.cwd(), 'backends', 'catalog.json'),
  config
);
assert.equal(backendCatalogValidation.ok, true);
assert.equal(backendCatalogValidation.kind, 'backendCatalog');
assert.equal(backendCatalogValidation.mediaType, 'application/vnd.lloom.backend-catalog+json;version=1');
assert.deepEqual(backendCatalogValidation.conformanceWarnings, []);
assert(backendCatalog.backends.length >= 6);
assert(backendIds(backendCatalog).has('mtplx'));
assert(backendIds(backendCatalog).has('llama-cpp'));
assert(backendIds(backendCatalog).has('ollama'));
assert(backendIds(backendCatalog).has('openai-compatible'));
assert(backendIds(backendCatalog).has('lm-studio'));
assert(backendIds(backendCatalog).has('vllm'));
assert(backendIds(backendCatalog).has('sglang'));
const mtplxBackend = getBackend(backendCatalog, 'mtplx');
assert(mtplxBackend);
const backendAuditVariables = {
  ...defaultBackendVariables({
    ...process.env,
    LLOOM_HOME: path.join(os.tmpdir(), `lloom-audit-${process.pid}`)
  }),
  installRoot: path.join(os.tmpdir(), `lloom-audit-${process.pid}`, 'backends'),
  backendRoot: path.join(os.tmpdir(), `lloom-audit-${process.pid}`, 'backends'),
  repoParent: path.join(os.tmpdir(), `lloom-audit-${process.pid}`, 'repos'),
  shimDir: path.join(os.tmpdir(), `lloom-audit-${process.pid}`, 'bin'),
  LLOOM_MTPLX_BIN: '',
  LLOOM_LLAMA_SERVER_BIN: '',
  LLOOM_VLLM_BIN: '',
  LLOOM_SGLANG_PYTHON: ''
};
const mtplxPlan = await planBackend(mtplxBackend, {
  checkCommands: false,
  variables: backendAuditVariables
});
assert.equal(mtplxPlan.id, 'mtplx');
assert.equal(mtplxPlan.platform, `${process.platform}-${process.arch}`);
assert(mtplxPlan.features.includes('mtp'));
assert(mtplxPlan.steps.some((step) => step.action === 'python-venv'));
assert(mtplxPlan.steps.some((step) => step.action === 'pip-install' && step.command.includes('mtplx')));
assert(mtplxPlan.steps.some((step) => step.action === 'link-command'));
assert.equal(mtplxPlan.setupAudit.network, true);
assert.equal(mtplxPlan.setupAudit.writesFilesystem, true);
assert(mtplxPlan.setupAudit.effects.includes('uses-network'));
const mtplxPipStep = mtplxPlan.steps.find((step) => step.action === 'pip-install');
assert.equal(mtplxPipStep.audit.risk, 'high');
assert(mtplxPipStep.audit.effects.includes('uses-network'));
assert(mtplxPipStep.audit.effects.includes('writes-files'));
const mtplxLinkStep = mtplxPlan.steps.find((step) => step.action === 'link-command');
assert.equal(mtplxLinkStep.audit.risk, 'medium');
assert(mtplxLinkStep.audit.effects.includes('creates-shim'));
const llamaPlan = await planBackend(getBackend(backendCatalog, 'llama-cpp'), {
  checkCommands: false,
  variables: backendAuditVariables
});
assert(
  llamaPlan.steps.some(
    (step) => step.action === 'git-clone' && step.repo === 'https://github.com/ggml-org/llama.cpp.git'
  )
);
assert(llamaPlan.steps.some((step) => step.action === 'cmake-configure'));
assert(llamaPlan.steps.some((step) => step.action === 'cmake-build'));
assert(
  llamaPlan.steps.some(
    (step) =>
      step.action === 'link-command' &&
      step.link.sourceCandidates.some((candidate) => candidate.includes('build-metal/bin/llama-server'))
  )
);
const llamaCloneStep = llamaPlan.steps.find((step) => step.action === 'git-clone');
assert.equal(llamaCloneStep.audit.risk, 'high');
assert(llamaCloneStep.audit.effects.includes('uses-network'));
assert(llamaCloneStep.audit.writes.some((entry) => entry.includes('llama.cpp')));
const llamaBuildStep = llamaPlan.steps.find((step) => step.action === 'cmake-build');
assert.equal(llamaBuildStep.audit.risk, 'medium');
assert(llamaBuildStep.audit.effects.includes('builds-source'));
const stableDiffusionPlan = await planBackend(getBackend(backendCatalog, 'stable-diffusion-cpp'), {
  checkCommands: false,
  variables: backendAuditVariables
});
assert(
  stableDiffusionPlan.steps.some(
    (step) => step.action === 'git-clone' && step.repo === 'https://github.com/leejet/stable-diffusion.cpp.git'
  )
);
assert(stableDiffusionPlan.steps.some((step) => step.action === 'link-command' && step.link.commandName === 'sd'));
const ollamaPlan = await planBackend(getBackend(backendCatalog, 'ollama'), {
  checkCommands: false,
  variables: backendAuditVariables
});
if (`${process.platform}-${process.arch}`.startsWith('darwin-')) {
  const ollamaBrewStep = ollamaPlan.steps.find(
    (step) => step.action === 'brew-install' && step.command.join(' ') === 'brew install ollama'
  );
  assert(ollamaBrewStep);
  assert(
    ollamaBrewStep.skip?.skip
      ? ollamaBrewStep.audit.effects.includes('skipped')
      : ollamaBrewStep.audit.effects.includes('modifies-system-package-manager')
  );
}
const syntheticBrewPlan = await planBackend(
  {
    id: 'synthetic-brew',
    name: 'Synthetic Brew',
    kind: 'tooling',
    setup: [
      {
        id: 'install-synthetic-brew',
        action: 'brew-install',
        packages: ['synthetic-package']
      }
    ]
  },
  {
    checkCommands: false,
    variables: backendAuditVariables
  }
);
assert.equal(syntheticBrewPlan.steps[0].audit.risk, 'high');
assert.equal(syntheticBrewPlan.steps[0].audit.modifiesSystem, true);
assert(syntheticBrewPlan.steps[0].audit.effects.includes('modifies-system-package-manager'));
const allBackendPlans = await planBackendCatalog(backendCatalog, { checkCommands: false });
assert(allBackendPlans.some((plan) => plan.id === 'vllm'));
const mlxLmPlan = await planBackend(getBackend(backendCatalog, 'mlx-lm'), {
  platform: 'darwin',
  arch: 'arm64',
  checkCommands: false,
  variables: {
    ...defaultBackendVariables({ ...process.env, LLOOM_HOME: '/lloom-home' }),
    installRoot: '/lloom-home/backends',
    backendRoot: '/lloom-home/backends',
    shimDir: '/lloom-home/bin'
  }
});
assert(
  mlxLmPlan.steps.some((step) => step.action === 'python-venv' && step.path === '/lloom-home/backends/mlx-lm/venv')
);
assert(
  mlxLmPlan.steps.some(
    (step) =>
      step.action === 'pip-install' &&
      step.command.join(' ') === '/lloom-home/backends/mlx-lm/venv/bin/python -m pip install --upgrade pip mlx-lm'
  )
);
assert(mlxLmPlan.steps.some((step) => step.action === 'link-command' && step.link.commandName === 'mlx_lm.server'));
const vllmPlan = await planBackend(getBackend(backendCatalog, 'vllm'), {
  platform: 'linux',
  arch: 'x64',
  checkCommands: false,
  variables: {
    ...defaultBackendVariables({
      ...process.env,
      LLOOM_HOME: '/lloom-home'
    }),
    installRoot: '/lloom-home/backends',
    backendRoot: '/lloom-home/backends',
    repoParent: '/repos',
    shimDir: '/lloom-home/bin',
    LLOOM_VLLM_BIN: ''
  }
});
assert.equal(vllmPlan.platformSupported, true);
assert(vllmPlan.steps.some((step) => step.action === 'python-venv' && step.path === '/lloom-home/backends/vllm/venv'));
assert(
  vllmPlan.steps.some(
    (step) =>
      step.action === 'pip-install' &&
      step.command.join(' ') === '/lloom-home/backends/vllm/venv/bin/python -m pip install --upgrade pip vllm'
  )
);
assert(
  vllmPlan.steps.some(
    (step) =>
      step.action === 'link-command' &&
      step.link.commandName === 'vllm' &&
      step.link.sourceCandidates.includes('/lloom-home/backends/vllm/venv/bin/vllm')
  )
);
assert.equal(vllmPlan.setupAudit.network, true);
assert.equal(vllmPlan.setupAudit.risks.high > 0, true);
const sglangPlan = await planBackend(getBackend(backendCatalog, 'sglang'), {
  platform: 'linux',
  arch: 'x64',
  checkCommands: false,
  variables: {
    ...defaultBackendVariables({
      ...process.env,
      LLOOM_HOME: '/lloom-home'
    }),
    installRoot: '/lloom-home/backends',
    backendRoot: '/lloom-home/backends',
    repoParent: '/repos',
    shimDir: '/lloom-home/bin',
    LLOOM_SGLANG_PYTHON: ''
  }
});
assert.equal(sglangPlan.platformSupported, true);
assert(sglangPlan.features.includes('vision'));
assert(
  sglangPlan.steps.some((step) => step.action === 'python-venv' && step.path === '/lloom-home/backends/sglang/venv')
);
assert(
  sglangPlan.steps.some(
    (step) =>
      step.action === 'pip-install' &&
      step.command.join(' ') === '/lloom-home/backends/sglang/venv/bin/python -m pip install --upgrade pip sglang'
  )
);
assert(
  sglangPlan.steps.some(
    (step) =>
      step.action === 'link-command' &&
      step.link.commandName === 'sglang-python' &&
      step.link.sourceCandidates.includes('/lloom-home/backends/sglang/venv/bin/python')
  )
);
assert.equal(sglangPlan.setupAudit.network, true);
assert.equal(sglangPlan.setupAudit.risks.high > 0, true);

const ggufReference = normalizeModelReference(
  'https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF/blob/main/Qwen3.6-27B-MTP-Q4_K_XL.gguf'
);
assert.equal(ggufReference.repoId, 'unsloth/Qwen3.6-27B-MTP-GGUF');
assert.equal(ggufReference.filePath, 'Qwen3.6-27B-MTP-Q4_K_XL.gguf');
assert.equal(ggufReference.revision, 'main');
assert.equal(ggufReference.canonical, 'unsloth/Qwen3.6-27B-MTP-GGUF/Qwen3.6-27B-MTP-Q4_K_XL.gguf');
assert.equal(inferBackend(ggufReference).backend, 'llama-cpp');
const ggufImportPlan = createModelImportPlan(config, {
  modelRef: ggufReference.input,
  modelRoot: '/models',
  port: 8400,
  contextWindow: 131072
});
assert.equal(ggufImportPlan.inference.backend, 'llama-cpp');
assert.equal(ggufImportPlan.additions.port, 8400);
assert.equal(ggufImportPlan.additions.modelPath, '/models/unsloth--Qwen3.6-27B-MTP-GGUF/Qwen3.6-27B-MTP-Q4_K_XL.gguf');
assert.deepEqual(ggufImportPlan.download.command, [
  'hf',
  'download',
  'unsloth/Qwen3.6-27B-MTP-GGUF',
  'Qwen3.6-27B-MTP-Q4_K_XL.gguf',
  '--local-dir',
  '/models/unsloth--Qwen3.6-27B-MTP-GGUF'
]);
assert.equal(
  ggufImportPlan.download.shellCommand,
  "'hf' 'download' 'unsloth/Qwen3.6-27B-MTP-GGUF' 'Qwen3.6-27B-MTP-Q4_K_XL.gguf' '--local-dir' '/models/unsloth--Qwen3.6-27B-MTP-GGUF'"
);
assert(ggufImportPlan.config.models.some((model) => model.id === 'unsloth/Qwen3.6-27B-MTP-GGUF'));
assert.equal(ggufImportPlan.config.runtimes['llama-cpp-unsloth-qwen3-6-27b-mtp-gguf'].args.at(-1), '131072');
assert(ggufImportPlan.next.apply.includes("--context-window '131072'"));
assert(ggufImportPlan.next.go.endsWith('--go'));
assert.equal(ggufImportPlan.next.setupBackend, "lloom backend-install 'llama-cpp' --apply --yes");

const revisionedHfReference = normalizeModelReference(
  'https://hf.co/acme/FastCoder-GGUF/resolve/v2.1/quant/FastCoder-Q4_K_M.gguf?download=true'
);
assert.equal(revisionedHfReference.repoId, 'acme/FastCoder-GGUF');
assert.equal(revisionedHfReference.revision, 'v2.1');
assert.equal(revisionedHfReference.filePath, 'quant/FastCoder-Q4_K_M.gguf');
assert.equal(revisionedHfReference.canonical, 'acme/FastCoder-GGUF@v2.1/quant/FastCoder-Q4_K_M.gguf');
const revisionedHfPlan = createModelImportPlan(config, {
  modelRef: revisionedHfReference.input,
  modelRoot: '/models',
  port: 8402
});
assert.deepEqual(revisionedHfPlan.download.command, [
  'hf',
  'download',
  'acme/FastCoder-GGUF',
  'quant/FastCoder-Q4_K_M.gguf',
  '--revision',
  'v2.1',
  '--local-dir',
  '/models/acme--FastCoder-GGUF'
]);
assert.equal(revisionedHfPlan.additions.modelPath, '/models/acme--FastCoder-GGUF/quant/FastCoder-Q4_K_M.gguf');

const revisionedRepoReference = normalizeModelReference(
  'https://huggingface.co/mlx-community/Qwen3.6-27B-OptiQ-4bit/tree/release-2026-07'
);
assert.equal(revisionedRepoReference.repoId, 'mlx-community/Qwen3.6-27B-OptiQ-4bit');
assert.equal(revisionedRepoReference.revision, 'release-2026-07');
assert.equal(revisionedRepoReference.filePath, null);
assert.equal(revisionedRepoReference.canonical, 'mlx-community/Qwen3.6-27B-OptiQ-4bit@release-2026-07');
const revisionedRepoPlan = createModelImportPlan(config, {
  modelRef: revisionedRepoReference.input,
  modelRoot: '/models',
  port: 8403
});
assert.deepEqual(revisionedRepoPlan.download.command, [
  'hf',
  'download',
  'mlx-community/Qwen3.6-27B-OptiQ-4bit',
  '--revision',
  'release-2026-07',
  '--local-dir',
  '/models/mlx-community--Qwen3.6-27B-OptiQ-4bit'
]);
assert.equal(revisionedRepoPlan.inference.backend, 'mlx-lm');

const mtplxImportPlan = createModelImportPlan(config, {
  modelRef: 'Youssofal/Qwen3.6-14B-MTPLX-Optimized-Speed',
  modelRoot: '/models',
  sessionCacheRoot: '/session-cache',
  port: 8401
});
assert.equal(mtplxImportPlan.inference.backend, 'mtplx');
assert.equal(
  mtplxImportPlan.config.runtimes['mtplx-youssofal-qwen3-6-14b-mtplx-optimized-speed'].sessionCache.dir,
  '/session-cache/mtplx-youssofal-qwen3-6-14b-mtplx-optimized-speed'
);

const vllmImportPlan = createModelImportPlan(config, {
  modelRef: 'Qwen/Qwen3-8B',
  backend: 'vllm',
  modelRoot: '/models',
  port: 8500,
  contextWindow: 65536
});
assert.equal(vllmImportPlan.inference.backend, 'vllm');
assert.deepEqual(vllmImportPlan.config.runtimes['vllm-qwen-qwen3-8b'].args, [
  'serve',
  '/models/Qwen--Qwen3-8B',
  '--host',
  '127.0.0.1',
  '--port',
  '8500',
  '--served-model-name',
  'Qwen/Qwen3-8B',
  '--tensor-parallel-size',
  '1',
  '--max-model-len',
  '65536',
  '--max-num-seqs',
  '4',
  '--gpu-memory-utilization',
  '0.85',
  '--enable-chunked-prefill',
  '--enable-prefix-caching',
  '--trust-remote-code'
]);
assert(vllmImportPlan.config.models.find((model) => model.id === 'Qwen/Qwen3-8B').capabilities.includes('batching'));
assert.equal(vllmImportPlan.next.setupBackend, "lloom backend-install 'vllm' --apply --yes");

const sglangImportPlan = createModelImportPlan(config, {
  modelRef: 'Qwen/Qwen3-8B',
  backend: 'sglang',
  modelRoot: '/models',
  port: 8501,
  contextWindow: 65536
});
assert.equal(sglangImportPlan.inference.backend, 'sglang');
assert.deepEqual(sglangImportPlan.config.runtimes['sglang-qwen-qwen3-8b'].args, [
  '-m',
  'sglang.launch_server',
  '--model-path',
  '/models/Qwen--Qwen3-8B',
  '--host',
  '127.0.0.1',
  '--port',
  '8501',
  '--served-model-name',
  'Qwen/Qwen3-8B',
  '--tp',
  '1',
  '--context-length',
  '65536',
  '--mem-fraction-static',
  '0.85',
  '--trust-remote-code'
]);
assert(sglangImportPlan.config.models.find((model) => model.id === 'Qwen/Qwen3-8B').capabilities.includes('rocm'));
assert.equal(sglangImportPlan.next.setupBackend, "lloom backend-install 'sglang' --apply --yes");

const ollamaImportPlan = createModelImportPlan(config, {
  modelRef: 'qwen3:8b',
  port: 11435
});
assert.equal(ollamaImportPlan.inference.backend, 'ollama');
assert.deepEqual(ollamaImportPlan.download.command, ['ollama', 'pull', 'qwen3:8b']);
assert.equal(ollamaImportPlan.config.runtimes['ollama-qwen3-8b'].env.OLLAMA_HOST, '127.0.0.1:11435');

const lmStudioReference = normalizeModelReference('lmstudio:local-qwen');
assert.equal(lmStudioReference.type, 'lm-studio');
assert.equal(inferBackend(lmStudioReference).backend, 'lm-studio');
const lmStudioImportPlan = createModelImportPlan(config, {
  modelRef: 'lmstudio:local-qwen',
  port: 1235,
  keepWarm: true
});
assert.equal(lmStudioImportPlan.inference.backend, 'lm-studio');
assert.equal(lmStudioImportPlan.additions.runtimeId, null);
assert.equal(lmStudioImportPlan.additions.baseUrl, 'http://127.0.0.1:1235/v1');
assert.equal(lmStudioImportPlan.config.backends['lm-studio-local-qwen'].baseUrl, 'http://127.0.0.1:1235/v1');
assert.equal(lmStudioImportPlan.config.models.find((model) => model.id === 'local-qwen').runtime, undefined);
assert.equal(lmStudioImportPlan.config.runtimes['lm-studio-local-qwen'], undefined);
assert.equal(lmStudioImportPlan.next.setupBackend, "lloom backend-install 'lm-studio' --apply --yes");
assert.equal(lmStudioImportPlan.next.start, null);

const openAICompatibleReference = normalizeModelReference('openai:http://127.0.0.1:9009/v1#remote-model');
assert.equal(openAICompatibleReference.type, 'openai-compatible');
assert.equal(inferBackend(openAICompatibleReference).backend, 'openai-compatible');
const openAICompatibleImportPlan = createModelImportPlan(config, {
  modelRef: 'openai:http://127.0.0.1:9009/v1#remote-model'
});
assert.equal(openAICompatibleImportPlan.inference.backend, 'openai-compatible');
assert.equal(openAICompatibleImportPlan.additions.baseUrl, 'http://127.0.0.1:9009/v1');
assert.equal(openAICompatibleImportPlan.additions.port, 9009);
assert.equal(openAICompatibleImportPlan.download, null);
assert.equal(
  openAICompatibleImportPlan.config.backends['openai-compatible-remote-model'].baseUrl,
  'http://127.0.0.1:9009/v1'
);
assert.equal(openAICompatibleImportPlan.config.models.find((model) => model.id === 'remote-model').runtime, undefined);
const openAICompatibleDefaultPortPlan = createModelImportPlan(config, {
  modelRef: 'openai:https://example.test/v1#remote-model-https'
});
assert.equal(openAICompatibleDefaultPortPlan.additions.port, null);
assert.equal(openAICompatibleDefaultPortPlan.additions.baseUrl, 'https://example.test/v1');
assert(!openAICompatibleDefaultPortPlan.next.apply.includes("--port '0'"));
const authenticatedExternalPlan = createModelImportPlan(config, {
  modelRef: 'openai:https://openrouter.ai/api/v1#z-ai/glm-5.2',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  name: 'GLM 5.2 · OpenRouter'
});
const authenticatedBackend = authenticatedExternalPlan.config.backends['openai-compatible-z-ai-glm-5-2'];
assert.equal(authenticatedBackend.apiKeyEnv, 'OPENROUTER_API_KEY');
assert.equal(authenticatedBackend.apiKey, undefined);
assert.deepEqual(authenticatedExternalPlan.config.security.apiKeys, config.sourceTemplate.security.apiKeys);
assert(authenticatedExternalPlan.next.apply.includes("--api-key-env 'OPENROUTER_API_KEY'"));
assert.throws(
  () =>
    createModelImportPlan(config, {
      modelRef: 'openai:https://openrouter.ai/api/v1#bad-env',
      apiKeyEnv: 'NOT-VALID'
    }),
  /valid environment variable name/
);

const models = registry.openAIModels().map((model) => model.id);
assert(models.includes('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
assert(models.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));
assert(models.includes('mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit'));
assert(!models.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed'));
assert(!models.includes('qwen36-27b-fastest'));
assert(!models.includes('qwen36-35b-fastest'));
assert(!models.includes('qwen3-tts'));

const clientModels = registry.clientModels({ kinds: ['chat'] }).map((model) => model.id);
assert.deepEqual(clientModels, [
  'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16',
  'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
]);

const resolved27b = registry.resolve('qwen36-27b-fastest');
assert.equal(resolved27b.model.id, 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed');

assert.throws(() => registry.resolve('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed'), /unknown local model/);

const recipe = await loadRecipeById('apple-silicon-qwen36');
assert.equal(recipe.schemaVersion, 1);
const loadedRecipes = await loadRecipes();
assert.deepEqual(
  loadedRecipes.map((candidate) => candidate.id),
  [
    'apple-silicon-qwen36-35b-a3b-optiq',
    'apple-silicon-qwen36',
    'high-memory-local-image-generation',
    'linux-nvidia-gb10-qwen36-unsloth-vllm',
    'linux-nvidia-gb10-thinkingcap-qwen36-27b-vllm',
    'linux-nvidia-qwen3-embedding-4b-vllm'
  ]
);
const benchmarkEvidence = await loadBenchmarkEvidence();
assert.equal(benchmarkEvidence.length, 11);
assert.deepEqual(validateBenchmarkEvidence(benchmarkEvidence), []);
const benchmarkSuite = JSON.parse(
  await fs.readFile(path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'), 'utf8')
);
assert.deepEqual(validateBenchmarkSuite(benchmarkSuite), []);
const benchmarkRanking = benchmarkOverview(benchmarkEvidence);
assert.equal(benchmarkRanking[0].model, 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16');
assert.equal(
  benchmarkRanking.find((result) => result.id === 'qwen36-27b-mtplx-speed-m2max-d3')?.model,
  'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
);
assert.equal(
  benchmarkRanking.find((result) => result.id === 'dgx-spark-unsloth-qwen36-27b-nvfp4-mtp2-s8-c8')?.metrics
    .generationTokPerSec,
  64.5017224203
);
const benchmarkSummary = summarizeBenchmarksForRecipe(recipe, benchmarkEvidence);
assert.equal(benchmarkSummary.length, 2);
assert.equal(
  benchmarkSummary.find((summary) => summary.role === 'fastest-27b')?.best?.metrics.generationTokPerSec,
  25.47
);
assert.equal(
  benchmarkSummary.find((summary) => summary.role === 'fastest-35b-a3b')?.best?.metrics.generationTokPerSec,
  68.58
);
const recipePlan = planRecipe(recipe, config, {
  modelRoot: '/models',
  backendIds: backendIds(backendCatalog),
  benchmarkEvidence,
  benchmarksRoot: 'benchmarks/community',
  benchmarkValidationErrors: []
});
assert.equal(recipePlan.platform, `${process.platform}-${process.arch}`);
assert.deepEqual(recipePlan.validationErrors, []);
assert.equal(recipePlan.benchmarks.validationErrors.length, 0);
assert.equal(
  recipePlan.models.find((model) => model.role === 'fastest-27b')?.benchmark.best.metrics.generationTokPerSec,
  25.47
);
assert(
  recipePlan.steps.some(
    (step) =>
      step.action === 'download-model' &&
      step.model === 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed' &&
      step.destination === '/models/Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed'
  )
);
assert(
  recipePlan.steps.some(
    (step) =>
      step.command?.join(' ') === 'mtplx tune --model /models/Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed --retune'
  )
);
const communityVllmRecipe = await loadRecipeById(
  'linux-nvidia-qwen36-27b-nvfp4-vllm',
  path.join(process.cwd(), 'community', 'recipes')
);
const communityVllmRecipePlan = planRecipe(communityVllmRecipe, config, {
  modelRoot: '/models',
  backendIds: backendIds(backendCatalog),
  checkLocalReferences: false
});
assert(
  communityVllmRecipePlan.steps.some(
    (step) =>
      step.action === 'download-model' &&
      step.model === 'nvidia/Qwen3.6-27B-NVFP4' &&
      step.destination === '/models/nvidia--Qwen3.6-27B-NVFP4'
  )
);

const recipeIndex = await loadRecipeIndex();
assert.deepEqual(validateRecipeIndex(recipeIndex), []);
const duplicateRecipeIndex = structuredClone(recipeIndex);
duplicateRecipeIndex.recipes.push({
  ...duplicateRecipeIndex.recipes[0]
});
assert(validateRecipeIndex(duplicateRecipeIndex).some((error) => error.includes('duplicate recipe index id')));
const traversalRecipeIndex = structuredClone(recipeIndex);
traversalRecipeIndex.recipes[0].path = '../escape.json';
assert(validateRecipeIndex(traversalRecipeIndex).some((error) => error.includes('recipes root')));
const versionedRecipeEntry = recipeIndex.recipes.find((entry) => entry.id === 'linux-nvidia-gb10-qwen36-unsloth-vllm');
assert.equal(versionedRecipeEntry.currentVersion, 2);
assert.equal(versionedRecipeEntry.versions.length, 2);
assert.equal(versionedRecipeEntry.versions.find((version) => version.status === 'archived')?.version, 1);
const mismatchedVersionIndex = structuredClone(recipeIndex);
const mismatchedVersionEntry = mismatchedVersionIndex.recipes.find(
  (entry) => entry.id === 'linux-nvidia-gb10-qwen36-unsloth-vllm'
);
mismatchedVersionEntry.currentVersion = 3;
assert(validateRecipeIndex(mismatchedVersionIndex).some((error) => error.includes('must match currentVersion')));
const recipeIndexReport = await buildRecipeIndexReport(config, {
  modelRoot: '/models',
  backendIds: backendIds(backendCatalog),
  benchmarkEvidence,
  benchmarksRoot: 'benchmarks/community',
  benchmarkValidationErrors: []
});
assert.equal(recipeIndexReport.ok, true);
assert.equal(recipeIndexReport.index.id, 'lloom-community-recipes');
assert.equal(recipeIndexReport.recipes.length, 6);
const indexedSparkRecipe = recipeIndexReport.recipes.find(
  (candidate) => candidate.id === 'linux-nvidia-gb10-qwen36-unsloth-vllm'
);
assert.equal(indexedSparkRecipe.currentVersion, 2);
assert.equal(indexedSparkRecipe.versions.length, 2);
assert.equal(indexedSparkRecipe.models.find((model) => model.role === 'dense-quality')?.benchmark.count, 3);
assert.equal(
  indexedSparkRecipe.models.find((model) => model.role === 'dense-quality')?.benchmark.best.recipeVersion,
  2
);
assert.equal(
  indexedSparkRecipe.models.find((model) => model.role === 'dense-quality')?.benchmark.best.metrics.generationTokPerSec,
  55.82
);
const indexedQwen36Recipe = recipeIndexReport.recipes.find((candidate) => candidate.id === 'apple-silicon-qwen36');
assert.equal(indexedQwen36Recipe.ok, true);
assert.equal(indexedQwen36Recipe.commands.plan, 'lloom plan apple-silicon-qwen36 --model-root /models');
assert.equal(
  indexedQwen36Recipe.commands.installApply,
  'lloom install apple-silicon-qwen36 --model-root /models --apply --yes'
);
assert.equal(
  indexedQwen36Recipe.models.find((model) => model.role === 'fastest-35b-a3b')?.benchmark.best.id,
  'qwen36-35b-a3b-mtplx-speed-fp16-m2max-d1'
);
const libraryCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'library',
  '--model-root',
  '/models'
]);
const libraryJson = JSON.parse(libraryCli.stdout);
assert.equal(libraryJson.index.id, 'lloom-community-recipes');
assert.equal(libraryJson.recipes[0].id, 'linux-nvidia-qwen3-embedding-4b-vllm');
if (process.platform === 'darwin' && process.arch === 'arm64') {
  assert.equal(libraryJson.selected.recipeId, 'apple-silicon-qwen36-35b-a3b-optiq');
} else {
  assert.equal(libraryJson.selected, null);
}
const addModelCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'add-model',
  'https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF/blob/main/Qwen3.6-27B-MTP-Q4_K_XL.gguf',
  '--model-root',
  '/models with spaces',
  '--port',
  '8403',
  '--config',
  config.sourcePath
]);
const addModelJson = JSON.parse(addModelCli.stdout);
assert.equal(addModelJson.inference.backend, 'llama-cpp');
assert.equal(addModelJson.additions.port, 8403);
assert.equal(
  addModelJson.download.shellCommand,
  "'hf' 'download' 'unsloth/Qwen3.6-27B-MTP-GGUF' 'Qwen3.6-27B-MTP-Q4_K_XL.gguf' '--local-dir' '/models with spaces/unsloth--Qwen3.6-27B-MTP-GGUF'"
);
assert(addModelJson.next.apply.includes("--model-root '/models with spaces'"));

const profile = await profileMachine();
assert.deepEqual(validateMachineProfile(profile), []);
assert.equal(profile.$schema, 'https://lloom.dev/schemas/machine-profile.v1.schema.json');
assert.equal(profile.platformId, `${process.platform}-${process.arch}`);
assert(profile.totalMemoryGb > 0);
assert(Array.isArray(profile.accelerators));
assert(Array.isArray(profile.devices));
if (profile.platformId === 'darwin-arm64') {
  assert(profile.accelerators.includes('apple-gpu'));
  assert(profile.devices.some((device) => device.id === 'apple-gpu' && device.backend === 'metal'));
}
const profileValidation = await validateInterchangeDocument(profile, config);
assert.equal(profileValidation.ok, true);
assert.equal(profileValidation.kind, 'machineProfile');
assert.equal(profileValidation.mediaType, MACHINE_PROFILE_MEDIA_TYPE);
const rankedRecipes = await rankRecipes([recipe], profile, { checkCommands: false });
assert.equal(rankedRecipes[0].recipeId, 'apple-silicon-qwen36');
const cudaRecipe = {
  id: 'synthetic-cuda',
  name: 'Synthetic CUDA',
  version: 1,
  requirements: {
    platforms: ['linux-x64'],
    memoryGb: 64,
    accelerators: ['cuda']
  }
};
const cudaProfile = normalizeMachineProfile({
  platform: 'linux',
  arch: 'x64',
  platformId: 'linux-x64',
  totalMemoryGb: '128',
  devices: [
    {
      id: 'cuda:0',
      kind: 'gpu',
      vendor: 'nvidia',
      name: 'NVIDIA Test GPU',
      backend: 'cuda',
      memoryGb: 80,
      computeCapability: '10.0'
    }
  ]
});
assert.equal(cudaProfile.totalMemoryGb, 128);
assert(cudaProfile.accelerators.includes('cuda'));
assert(cudaProfile.accelerators.includes('nvidia-gpu'));
assert.equal((await rankRecipes([cudaRecipe], cudaProfile, { checkCommands: false }))[0].selectable, true);
const noGpuProfile = normalizeMachineProfile({
  platform: 'linux',
  arch: 'x64',
  platformId: 'linux-x64',
  totalMemoryGb: 128,
  accelerators: [],
  devices: []
});
const noGpuCudaRanked = await rankRecipes([cudaRecipe], noGpuProfile, { checkCommands: false });
assert.equal(noGpuCudaRanked[0].selectable, false);
assert.deepEqual(noGpuCudaRanked[0].missingAccelerators, ['cuda']);
const unknownMemoryProfile = normalizeMachineProfile({
  platform: 'darwin',
  arch: 'arm64',
  platformId: 'darwin-arm64',
  accelerators: ['apple-gpu']
});
assert.equal(unknownMemoryProfile.totalMemoryGb, undefined);
assert.deepEqual(validateMachineProfile(unknownMemoryProfile), []);
const unknownMemoryRanked = await rankRecipes([recipe], unknownMemoryProfile, { checkCommands: false });
assert.equal(unknownMemoryRanked[0].selectable, true);
assert.equal(unknownMemoryRanked[0].memorySupported, null);
assert(unknownMemoryRanked[0].reasons.some((reason) => reason.includes('memory unknown')));

// Pure plan/admit cases live in test/runtime-policy.test.mjs.
// Smoke keeps concurrent admission serialization against RuntimeManager.
const serializedPolicyConfig = {
  runtimePolicy: {
    memoryBudgetGb: 40,
    protectActiveRequests: true
  },
  runtimes: {
    'warm-a': {
      enabled: true,
      memoryGb: 30
    },
    'cold-b': {
      enabled: true,
      memoryGb: 30
    },
    'cold-c': {
      enabled: true,
      memoryGb: 30
    }
  }
};
const serializedPolicyManager = new RuntimeManager(serializedPolicyConfig, {
  logger: { error() {} }
});
const serializedLoadedRuntimes = new Set(['warm-a']);
const serializedPolicyOperations = [];
serializedPolicyManager.status = async () => ({
  runtimes: Object.fromEntries(
    Object.keys(serializedPolicyConfig.runtimes).map((runtimeId) => [
      runtimeId,
      {
        healthy: serializedLoadedRuntimes.has(runtimeId),
        status: serializedLoadedRuntimes.has(runtimeId) ? 'running' : 'idle',
        activeRequests: 0,
        queuedRequests: 0
      }
    ])
  )
});
serializedPolicyManager.stop = async (runtimeId) => {
  serializedPolicyOperations.push(`stop:${runtimeId}`);
  await wait(5);
  serializedLoadedRuntimes.delete(runtimeId);
  return { runtimeId, stopped: true };
};
serializedPolicyManager.start = async (runtimeId, options) => {
  serializedPolicyOperations.push(`start:${runtimeId}:${options.reason}`);
  await wait(5);
  serializedLoadedRuntimes.add(runtimeId);
  return { runtimeId, started: true, options };
};
const [serializedAdmissionB, serializedAdmissionC] = await Promise.all([
  applyRuntimePolicyPlan(serializedPolicyConfig, serializedPolicyManager, {
    requestedRuntimeId: 'cold-b',
    dryRun: false,
    yes: true,
    reason: 'serialized-admit'
  }),
  applyRuntimePolicyPlan(serializedPolicyConfig, serializedPolicyManager, {
    requestedRuntimeId: 'cold-c',
    dryRun: false,
    yes: true,
    reason: 'serialized-admit'
  })
]);
assert.deepEqual(
  serializedAdmissionB.results.map((result) => `${result.type}:${result.runtimeId}`),
  ['stop:warm-a', 'start:cold-b']
);
assert.deepEqual(
  serializedAdmissionC.results.map((result) => `${result.type}:${result.runtimeId}`),
  ['stop:cold-b', 'start:cold-c']
);
assert.deepEqual(serializedPolicyOperations, [
  'stop:warm-a',
  'start:cold-b:serialized-admit',
  'stop:cold-b',
  'start:cold-c:serialized-admit'
]);
assert.deepEqual([...serializedLoadedRuntimes], ['cold-c']);

const installDryRun = await applyRecipe(recipe, config, {
  dryRun: true,
  modelRoot: '/models',
  statePath: path.join(os.tmpdir(), `lloom-dry-run-${process.pid}.json`)
});
assert.equal(installDryRun.dryRun, true);
assert(installDryRun.results.every((step) => step.status === 'planned'));

await assert.rejects(
  () =>
    applyRecipe(recipe, config, {
      dryRun: false,
      modelRoot: '/models',
      statePath: path.join(os.tmpdir(), `lloom-refuse-${process.pid}.json`)
    }),
  /Refusing to execute recipe/
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-installer-'));
const statePath = path.join(tempDir, 'state.json');

const intakeConfigPath = path.join(tempDir, 'model-intake-config.json');
await fs.writeFile(intakeConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
const intakeBaseConfig = await loadConfig(intakeConfigPath);
const intakeApplied = await applyModelImport(intakeBaseConfig, {
  dryRun: false,
  yes: true,
  configPath: intakeConfigPath,
  modelRef: 'mlx-community/Qwen3.5-4B-Instruct-4bit',
  modelRoot: path.join(tempDir, 'intake models'),
  port: 8402,
  keepWarm: true,
  setDefault: true
});
assert.equal(intakeApplied.dryRun, false);
assert.equal(intakeApplied.written.configPath, intakeConfigPath);
const writtenIntakeConfig = JSON.parse(await fs.readFile(intakeConfigPath, 'utf8'));
assert(writtenIntakeConfig.models.some((model) => model.id === 'mlx-community/Qwen3.5-4B-Instruct-4bit'));
assert.equal(writtenIntakeConfig.defaults.chatModel, 'mlx-community/Qwen3.5-4B-Instruct-4bit');
assert.equal(writtenIntakeConfig.runtimes['mlx-lm-mlx-community-qwen3-5-4b-instruct-4bit'].keepWarm, true);
assert.equal(
  writtenIntakeConfig.runtimes['mlx-lm-mlx-community-qwen3-5-4b-instruct-4bit'].args.at(1),
  path.join(tempDir, 'intake models', 'mlx-community--Qwen3.5-4B-Instruct-4bit')
);
assert(intakeApplied.next.apply.includes(`--config '${intakeConfigPath}'`));
assert(intakeApplied.next.apply.includes(`--model-root '${path.join(tempDir, 'intake models')}'`));

writtenIntakeConfig.aliases = {
  quick: 'mlx-community/Qwen3.5-4B-Instruct-4bit',
  quicker: { target: 'mlx-community/Qwen3.5-4B-Instruct-4bit', advertise: true }
};
writtenIntakeConfig.clientCatalog.modelOrder.push('quick');
await fs.writeFile(intakeConfigPath, `${JSON.stringify(writtenIntakeConfig, null, 2)}\n`, 'utf8');
const removableIntakeConfig = await loadConfig(intakeConfigPath);
const removalRuntimeId = 'mlx-lm-mlx-community-qwen3-5-4b-instruct-4bit';
const activeRemovalPlan = createModelRemovalPlan(removableIntakeConfig, {
  modelId: 'mlx-community/Qwen3.5-4B-Instruct-4bit',
  runtimeStatus: { runtimes: { [removalRuntimeId]: { status: 'running', healthy: true, activeRequests: 1 } } }
});
assert.equal(activeRemovalPlan.ok, false);
assert.match(activeRemovalPlan.validationErrors[0], /active request/);
const removalPlan = createModelRemovalPlan(removableIntakeConfig, {
  modelId: 'mlx-community/Qwen3.5-4B-Instruct-4bit',
  runtimeStatus: { runtimes: { [removalRuntimeId]: { status: 'running', healthy: true, activeRequests: 0 } } }
});
assert.equal(removalPlan.ok, true);
assert.equal(removalPlan.cleanup.backend, removalRuntimeId);
assert.equal(removalPlan.cleanup.runtime, removalRuntimeId);
assert.deepEqual(removalPlan.cleanup.aliases, ['quick', 'quicker']);
assert.deepEqual(removalPlan.cleanup.defaultKeys, ['chatModel']);
assert.equal(removalPlan.cleanup.modelFiles, null);
assert(removalPlan.preserved.modelFiles.includes('mlx-community--Qwen3.5-4B-Instruct-4bit'));
assert.equal(JSON.stringify(removalPlan).includes('"config"'), false);
let removedRuntimeId = null;
const removalApplied = await applyModelRemoval(removableIntakeConfig, {
  modelId: 'mlx-community/Qwen3.5-4B-Instruct-4bit',
  configPath: intakeConfigPath,
  runtimeStatus: { runtimes: { [removalRuntimeId]: { status: 'running', healthy: true, activeRequests: 0 } } },
  stopRuntime: async (runtimeId) => {
    removedRuntimeId = runtimeId;
    return { runtimeId, stopped: true };
  },
  dryRun: false,
  yes: true
});
assert.equal(removedRuntimeId, removalRuntimeId);
assert(removalApplied.written.backupPath.includes('.bak-'));
const removedIntakeConfig = JSON.parse(await fs.readFile(intakeConfigPath, 'utf8'));
assert(!removedIntakeConfig.models.some((model) => model.id === 'mlx-community/Qwen3.5-4B-Instruct-4bit'));
assert.equal(removedIntakeConfig.backends[removalRuntimeId], undefined);
assert.equal(removedIntakeConfig.runtimes[removalRuntimeId], undefined);
assert.equal(removedIntakeConfig.aliases.quick, undefined);
assert.equal(removedIntakeConfig.aliases.quicker, undefined);
assert.equal(removedIntakeConfig.defaults.chatModel, undefined);
assert(!removedIntakeConfig.clientCatalog.modelOrder.includes('quick'));

const sharedRemovalPlan = createModelRemovalPlan(
  {
    models: [
      { id: 'remove-me', backend: 'shared', runtime: 'shared-runtime' },
      { id: 'keep-me', backend: 'shared', runtime: 'shared-runtime' }
    ],
    backends: { shared: { type: 'openai' } },
    runtimes: { 'shared-runtime': { args: [] } },
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['remove-me', 'keep-me'] }
  },
  { modelId: 'remove-me' }
);
assert.equal(sharedRemovalPlan.cleanup.backend, null);
assert.equal(sharedRemovalPlan.cleanup.runtime, null);
assert.deepEqual(sharedRemovalPlan.preserved.backend.usedBy, ['keep-me']);
assert.deepEqual(sharedRemovalPlan.preserved.runtime.usedBy, ['keep-me']);

const deleteModelRoot = path.join(tempDir, 'delete-models');
const deleteModelPath = path.join(deleteModelRoot, 'synthetic--delete-me');
const deleteConfigPath = path.join(tempDir, 'model-removal-delete-config.json');
await fs.mkdir(deleteModelPath, { recursive: true });
await fs.writeFile(path.join(deleteModelPath, 'weights.safetensors'), 'synthetic');
await fs.writeFile(
  deleteConfigPath,
  `${JSON.stringify(
    {
      paths: { modelRoot: deleteModelRoot },
      models: [{ id: 'delete-me', backend: 'delete-backend', runtime: 'delete-runtime' }],
      backends: { 'delete-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:65530/v1' } },
      runtimes: { 'delete-runtime': { enabled: true, command: 'synthetic', args: ['--model', deleteModelPath] } },
      aliases: {},
      defaults: {},
      clientCatalog: { modelOrder: ['delete-me'] }
    },
    null,
    2
  )}\n`
);
const deleteRemovalConfig = await loadConfig(deleteConfigPath);
const deleteRemovalApplied = await applyModelRemoval(deleteRemovalConfig, {
  modelId: 'delete-me',
  deleteFiles: true,
  configPath: deleteConfigPath,
  runtimeStatus: { runtimes: { 'delete-runtime': { status: 'stopped', activeRequests: 0 } } },
  dryRun: false,
  yes: true
});
assert.equal(deleteRemovalApplied.deletedFiles, deleteModelPath);
await assert.rejects(() => fs.access(deleteModelPath));

const goConfigPath = path.join(tempDir, 'model-intake-go-config.json');
await fs.writeFile(goConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
const goBaseConfig = await loadConfig(goConfigPath);
const goPhases = [];
const goApplied = await applyModelImportGo(
  goBaseConfig,
  {
    configPath: goConfigPath,
    modelRef: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
    modelRoot: path.join(tempDir, 'go models'),
    port: 8404,
    keepWarm: true,
    setDefault: true
  },
  {
    async installBackend(plan) {
      goPhases.push(`backend:${plan.inference.backend}`);
      assert.equal(plan.inference.backend, 'mlx-lm');
      return { ok: true, status: 'completed' };
    },
    async downloadModel(plan) {
      goPhases.push(`download:${plan.reference.repoId}`);
      return { ok: true, status: 'completed' };
    },
    async startRuntime(plan, nextConfig) {
      goPhases.push(`runtime:${plan.additions.runtimeId}`);
      assert(nextConfig.models.some((model) => model.id === 'mlx-community/Qwen3.6-27B-OptiQ-4bit'));
      const written = JSON.parse(await fs.readFile(goConfigPath, 'utf8'));
      assert.equal(written.defaults.chatModel, 'mlx-community/Qwen3.6-27B-OptiQ-4bit');
      return { ok: true, healthy: true, started: true };
    }
  }
);
assert.equal(goApplied.go, true);
assert.equal(goApplied.status, 'ready');
assert.deepEqual(goPhases, [
  'backend:mlx-lm',
  'download:mlx-community/Qwen3.6-27B-OptiQ-4bit',
  'runtime:mlx-lm-mlx-community-qwen3-6-27b-optiq-4bit'
]);

const failedGoConfigPath = path.join(tempDir, 'model-intake-go-failed-config.json');
await fs.writeFile(failedGoConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
const failedGoBaseConfig = await loadConfig(failedGoConfigPath);
await assert.rejects(
  () =>
    applyModelImportGo(
      failedGoBaseConfig,
      {
        configPath: failedGoConfigPath,
        modelRef: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
        modelRoot: path.join(tempDir, 'failed go models'),
        port: 8405
      },
      {
        installBackend: async () => ({ ok: true }),
        downloadModel: async () => ({ ok: false, error: 'synthetic download failure' }),
        startRuntime: async () => ({ ok: true, healthy: true })
      }
    ),
  /synthetic download failure/
);
const failedGoConfig = JSON.parse(await fs.readFile(failedGoConfigPath, 'utf8'));
assert(!failedGoConfig.models.some((model) => model.id === 'mlx-community/Qwen3.6-27B-OptiQ-4bit'));

const unmanagedGoConfigPath = path.join(tempDir, 'model-intake-unmanaged-go-config.json');
await fs.writeFile(unmanagedGoConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
const unmanagedGoCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'add-model',
  'openai:http://127.0.0.1:9999/v1#synthetic-external',
  '--default',
  '--go',
  '--config',
  unmanagedGoConfigPath
]);
const unmanagedGoResult = JSON.parse(unmanagedGoCli.stdout);
assert.equal(unmanagedGoResult.go, true);
assert.equal(unmanagedGoResult.status, 'ready');
assert.equal(unmanagedGoResult.phases.backend.reason, 'unmanaged-model');
assert.equal(unmanagedGoResult.phases.download.reason, 'no-download');
assert.equal(unmanagedGoResult.phases.runtime.reason, 'unmanaged-model');
const unmanagedGoConfig = JSON.parse(await fs.readFile(unmanagedGoConfigPath, 'utf8'));
assert.equal(unmanagedGoConfig.defaults.chatModel, 'synthetic-external');

const packRecipesRoot = path.join(tempDir, 'pack-recipes');
const packBenchmarksRoot = path.join(tempDir, 'pack-benchmarks');
const packIndexPath = path.join(packRecipesRoot, 'index.json');
const packPath = path.join(tempDir, 'synthetic-recipe-pack.json');
const signedPackPath = path.join(tempDir, 'synthetic-signed-recipe-pack.json');
const tamperedPackPath = path.join(tempDir, 'synthetic-tampered-recipe-pack.json');
const trustedPublicKeyPath = path.join(tempDir, 'synthetic-pack-public.pem');
const packedRecipe = {
  $schema: 'https://lloom.dev/schemas/recipe.v1.schema.json',
  schemaVersion: 1,
  id: 'synthetic-pack',
  name: 'Synthetic Pack',
  version: 1,
  summary: 'Synthetic importable recipe pack.',
  requirements: {
    platforms: [`${process.platform}-${process.arch}`]
  },
  backend: {
    id: 'mtplx'
  },
  setup: {
    steps: [
      {
        id: 'noop',
        action: 'command',
        command: '/usr/bin/true'
      }
    ]
  },
  models: [
    {
      role: 'default',
      model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      runtime: 'mtplx-qwen36-27b-speed',
      capabilities: ['chat', 'streaming', 'usage', 'tools', 'reasoning', 'mtp', 'long-context'],
      settings: {
        profile: 'turbo',
        draftDepth: 3,
        contextWindow: 262144,
        maxOutputTokens: 32768,
        maxActiveRequests: 10
      }
    }
  ]
};
const packedBenchmarkSuite = {
  schemaVersion: 1,
  id: 'synthetic-pack-benchmarks',
  name: 'Synthetic Pack Benchmarks',
  submittedAt: '2026-07-07T00:00:00Z',
  source: {
    type: 'local-test'
  },
  results: [
    {
      id: 'synthetic-pack-d1',
      recipeId: 'synthetic-pack',
      backendId: 'mtplx',
      model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      machine: {
        platformId: `${process.platform}-${process.arch}`
      },
      metrics: {
        generationTokPerSec: 12.34,
        contextWindow: 262144
      }
    }
  ]
};
const packDocument = {
  schemaVersion: 1,
  id: 'synthetic-pack-bundle',
  name: 'Synthetic Pack Bundle',
  updatedAt: '2026-07-07T00:00:00Z',
  recipes: [
    {
      index: {
        id: 'synthetic-pack',
        path: 'synthetic-pack.json',
        name: 'Synthetic Pack',
        summary: 'Synthetic importable recipe pack.',
        tags: ['synthetic', 'test'],
        recommendedFor: ['smoke tests'],
        source: {
          type: 'recipe-pack',
          url: 'synthetic-recipe-pack.json'
        }
      },
      recipe: packedRecipe,
      benchmarks: [packedBenchmarkSuite]
    }
  ]
};
await fs.writeFile(packPath, `${JSON.stringify(packDocument, null, 2)}\n`, 'utf8');
const packPlan = await createRecipePackPlan(packPath, config, {
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot
});
assert.equal(packPlan.ok, true);
assert.equal(packPlan.pack.recipeCount, 1);
assert.equal(packPlan.signature.signed, false);
assert.equal(packPlan.writableActions, undefined);
assert.equal(packPlan.actions.find((action) => action.type === 'recipe').status, 'create');
assert.equal(packPlan.actions.find((action) => action.type === 'benchmark').status, 'create');
const unsignedRequiredPlan = await createRecipePackPlan(packPath, config, {
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot,
  requireSignature: true
});
assert.equal(unsignedRequiredPlan.ok, false);
assert(unsignedRequiredPlan.validationErrors.some((error) => error.includes('requires a signature')));
await assert.rejects(
  () =>
    applyRecipePack(packPath, config, {
      dryRun: false,
      indexPath: packIndexPath,
      recipesRoot: packRecipesRoot,
      benchmarksRoot: packBenchmarksRoot
    }),
  /Refusing to import recipe pack/
);
const packCliPlan = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'recipe-import',
      packPath,
      '--index',
      packIndexPath,
      '--recipes-root',
      packRecipesRoot,
      '--benchmarks-root',
      packBenchmarksRoot
    ])
  ).stdout
);
assert.equal(packCliPlan.ok, true);
assert.equal(packCliPlan.writableActions, undefined);
assert.equal(packCliPlan.actions.find((action) => action.type === 'index').status, 'create');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
await fs.writeFile(trustedPublicKeyPath, publicKeyPem, 'utf8');
const signedPackDocument = structuredClone(packDocument);
signedPackDocument.signatures = [
  createRecipePackSignature(signedPackDocument, {
    keyId: 'synthetic-test',
    privateKey: privateKeyPem,
    publicKey: publicKeyPem
  })
];
await fs.writeFile(signedPackPath, `${JSON.stringify(signedPackDocument, null, 2)}\n`, 'utf8');
const signedPlan = await createRecipePackPlan(signedPackPath, config, {
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot,
  requireSignature: true,
  trustedKeys: [{ keyId: 'synthetic-test', publicKey: publicKeyPem }]
});
assert.equal(signedPlan.ok, true);
assert.equal(signedPlan.signature.signed, true);
assert.equal(signedPlan.signature.verified, true);
assert.equal(signedPlan.signature.trusted, true);
const signedCliPlan = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'recipe-import',
      signedPackPath,
      '--index',
      packIndexPath,
      '--recipes-root',
      packRecipesRoot,
      '--benchmarks-root',
      packBenchmarksRoot,
      '--trusted-key',
      `synthetic-test=${trustedPublicKeyPath}`,
      '--require-signature'
    ])
  ).stdout
);
assert.equal(signedCliPlan.ok, true);
assert.equal(signedCliPlan.signature.trusted, true);
const tamperedPackDocument = structuredClone(signedPackDocument);
tamperedPackDocument.recipes[0].recipe.name = 'Tampered Pack';
await fs.writeFile(tamperedPackPath, `${JSON.stringify(tamperedPackDocument, null, 2)}\n`, 'utf8');
const tamperedPlan = await createRecipePackPlan(tamperedPackPath, config, {
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot,
  requireSignature: true,
  trustedKeys: [{ keyId: 'synthetic-test', publicKey: publicKeyPem }]
});
assert.equal(tamperedPlan.ok, false);
assert(tamperedPlan.validationErrors.some((error) => error.includes('none verified')));
await assert.rejects(
  () =>
    applyRecipePack(tamperedPackPath, config, {
      dryRun: false,
      yes: true,
      indexPath: packIndexPath,
      recipesRoot: packRecipesRoot,
      benchmarksRoot: packBenchmarksRoot,
      requireSignature: true,
      trustedKeys: [{ keyId: 'synthetic-test', publicKey: publicKeyPem }]
    }),
  /Recipe pack is invalid/
);
const packApplied = await applyRecipePack(packPath, config, {
  dryRun: false,
  yes: true,
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot
});
assert.equal(packApplied.dryRun, false);
assert.equal(packApplied.results.filter((result) => result.status === 'written').length, 3);
const importedRecipe = JSON.parse(await fs.readFile(path.join(packRecipesRoot, 'synthetic-pack.json'), 'utf8'));
assert.equal(importedRecipe.id, 'synthetic-pack');
const importedIndex = JSON.parse(await fs.readFile(packIndexPath, 'utf8'));
assert.equal(importedIndex.recipes[0].id, 'synthetic-pack');
const importedBenchmark = JSON.parse(
  await fs.readFile(path.join(packBenchmarksRoot, 'synthetic-pack-benchmarks.json'), 'utf8')
);
assert.equal(importedBenchmark.results[0].id, 'synthetic-pack-d1');
const importedReport = await buildRecipeIndexReport(config, {
  indexPath: packIndexPath,
  recipesRoot: packRecipesRoot,
  benchmarksRoot: packBenchmarksRoot,
  modelRoot: '/models',
  backendIds: backendIds(backendCatalog)
});
assert.equal(importedReport.ok, true);
assert.equal(importedReport.recipes[0].id, 'synthetic-pack');
assert.equal(importedReport.recipes[0].benchmarks.models[0].best.metrics.generationTokPerSec, 12.34);

const exportPath = path.join(tempDir, 'apple-silicon-qwen36-export.json');
const exportPlan = await writeRecipePackExport(config, {
  recipeIds: ['apple-silicon-qwen36'],
  outputPath: exportPath
});
assert.equal(exportPlan.ok, true);
assert.equal(exportPlan.dryRun, true);
assert.equal(exportPlan.pack.recipeCount, 1);
assert.equal(exportPlan.pack.benchmarkCount, 1);
assert.equal(exportPlan.document.$schema, 'https://lloom.dev/schemas/recipe-pack.v1.schema.json');
assert.equal(exportPlan.importPlan.ok, true);
await assert.rejects(
  () =>
    writeRecipePackExport(config, {
      recipeIds: ['apple-silicon-qwen36'],
      outputPath: exportPath,
      dryRun: false
    }),
  /Refusing to write recipe pack export/
);
const exportApplied = await writeRecipePackExport(config, {
  recipeIds: ['apple-silicon-qwen36'],
  outputPath: exportPath,
  dryRun: false,
  yes: true
});
assert.equal(exportApplied.dryRun, false);
assert.equal(exportApplied.written.path, exportPath);
const exportedDocument = JSON.parse(await fs.readFile(exportPath, 'utf8'));
assert.equal(exportedDocument.$schema, 'https://lloom.dev/schemas/recipe-pack.v1.schema.json');
assert.equal(exportedDocument.recipes[0].recipe.id, 'apple-silicon-qwen36');
assert.equal(exportedDocument.recipes[0].benchmarks[0].results.length, 2);
const recipeValidation = await createInterchangeValidationReport(
  path.join(process.cwd(), 'recipes', 'apple-silicon-qwen36.json'),
  config
);
assert.equal(recipeValidation.ok, true);
assert.equal(recipeValidation.kind, 'recipe');
assert.equal(recipeValidation.mediaType, 'application/vnd.lloom.recipe+json;version=1');
assert.equal(recipeValidation.profile, 'https://lloom.dev/profiles/interchange/v1');
assert(Array.isArray(recipeValidation.conformanceWarnings));
const indexValidation = await createInterchangeValidationReport(
  path.join(process.cwd(), 'recipes', 'index.json'),
  config
);
assert.equal(indexValidation.ok, true);
assert.equal(indexValidation.kind, 'recipeIndex');
const benchmarkValidation = await createInterchangeValidationReport(
  path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'),
  config
);
assert.equal(benchmarkValidation.ok, true);
assert.equal(benchmarkValidation.kind, 'benchmarkSuite');
const packValidation = await createInterchangeValidationReport(exportPath, config, {
  indexPath: path.join(tempDir, 'validate-pack-recipes', 'index.json'),
  recipesRoot: path.join(tempDir, 'validate-pack-recipes'),
  benchmarksRoot: path.join(tempDir, 'validate-pack-benchmarks')
});
assert.equal(packValidation.ok, true);
assert.equal(packValidation.kind, 'recipePack');
assert.equal(packValidation.mediaType, 'application/vnd.lloom.recipe-pack+json;version=1');
assert.equal(packValidation.conformance.canonicalization, 'lloom-canonical-json-v1');
const interchangeRegistryDocument = createInterchangeRegistry();
const interchangeRegistryValidation = await validateInterchangeDocument(interchangeRegistryDocument, config);
assert.equal(interchangeRegistryValidation.ok, true);
assert.equal(interchangeRegistryValidation.kind, 'interchangeRegistry');
assert.equal(interchangeRegistryValidation.$schema, VALIDATION_REPORT_SCHEMA);
assert.equal(interchangeRegistryValidation.mediaType, INTERCHANGE_REGISTRY_MEDIA_TYPE);
assert.equal(interchangeRegistryValidation.conformanceLevel, 'validate');
assert(Array.isArray(interchangeRegistryValidation.validationErrors));
assert(Array.isArray(interchangeRegistryValidation.conformanceWarnings));
assert(interchangeRegistryDocument.documents.some((document) => document.kind === 'recipePack'));
assert(interchangeRegistryDocument.documents.some((document) => document.kind === 'signingKeys'));
assert(interchangeRegistryDocument.documents.some((document) => document.kind === 'errorResponse'));
assert(interchangeRegistryDocument.documents.some((document) => document.kind === 'validationReport'));
assert(interchangeRegistryDocument.links.some((link) => link.rel === 'profile'));
assert(interchangeRegistryDocument.links.some((link) => link.rel === 'extension-policy'));
assert(interchangeRegistryDocument.endpoints.some((endpoint) => endpoint.path === '/v1/recipe-packs'));
assert(interchangeRegistryDocument.endpoints.every((endpoint) => endpoint.errorKind === 'errorResponse'));
const errorResponse = createErrorResponse('unknown recipe pack example', {
  status: 404,
  code: 'not_found',
  host: {
    service: 'lloom-host',
    endpoint: '/v1/recipe-packs/example'
  }
});
const errorResponseValidation = await validateInterchangeDocument(errorResponse, config);
assert.equal(errorResponseValidation.ok, true);
assert.equal(errorResponseValidation.kind, 'errorResponse');
assert.equal(errorResponseValidation.mediaType, ERROR_RESPONSE_MEDIA_TYPE);
assert.equal(errorResponseValidation.$schema, VALIDATION_REPORT_SCHEMA);
assert.equal(errorResponseValidation.profile, 'https://lloom.dev/profiles/interchange/v1');
assert.equal(
  errorResponseValidation.conformance.compatibility.validationReports,
  'validation-report.v1 is the stable automation contract for validator and CI output'
);
const interchangeExamples = [
  ['interchangeRegistry', 'interchange-registry.v1.json'],
  ['backendCatalog', 'backend-catalog.v1.json'],
  ['clientIntegrations', 'client-integrations.v1.json'],
  ['machineProfile', 'machine-profile.v1.json'],
  ['recommendationResponse', 'recommendation-response.v1.json'],
  ['recipe', 'recipe.v1.json'],
  ['recipeIndex', 'recipe-index.v1.json'],
  ['benchmarkSuite', 'benchmark-suite.v1.json'],
  ['benchmarkSubmissionResponse', 'benchmark-submission-response.v1.json'],
  ['recipePack', 'recipe-pack.v1.json'],
  ['recipePackSubmissionResponse', 'recipe-pack-submission-response.v1.json'],
  ['signingKeys', 'signing-keys.v1.json'],
  ['errorResponse', 'error-response.v1.json'],
  ['validationReport', 'validation-report.v1.json']
];
for (const [kind, fileName] of interchangeExamples) {
  const exampleValidation = await createInterchangeValidationReport(
    path.join(process.cwd(), 'examples', 'interchange', fileName),
    config,
    {
      indexPath: path.join(tempDir, 'example-pack-recipes', 'index.json'),
      recipesRoot: path.join(tempDir, 'example-pack-recipes'),
      benchmarksRoot: path.join(tempDir, 'example-pack-benchmarks')
    }
  );
  assert.equal(exampleValidation.ok, true);
  assert.equal(exampleValidation.kind, kind);
  assert.equal(exampleValidation.profile, 'https://lloom.dev/profiles/interchange/v1');
  assert(Array.isArray(exampleValidation.conformanceWarnings));
}
const validateCli = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'validate',
      exportPath,
      '--index',
      path.join(tempDir, 'validate-cli-recipes', 'index.json'),
      '--recipes-root',
      path.join(tempDir, 'validate-cli-recipes'),
      '--benchmarks-root',
      path.join(tempDir, 'validate-cli-benchmarks')
    ])
  ).stdout
);
assert.equal(validateCli.ok, true);
assert.equal(validateCli.kind, 'recipePack');
assert.equal(validateCli.$schema, VALIDATION_REPORT_SCHEMA);
assert.equal(validateCli.schemaVersion, 1);
assert.equal(validateCli.profile, 'https://lloom.dev/profiles/interchange/v1');
assert.equal(validateCli.schema, 'https://lloom.dev/schemas/recipe-pack.v1.schema.json');
assert.equal(validateCli.mediaType, 'application/vnd.lloom.recipe-pack+json;version=1');
assert.equal(validateCli.conformanceLevel, 'validate');
assert(Array.isArray(validateCli.validationErrors));
const helpCli = (await runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'help'])).stdout;
assert(helpCli.includes('Primary commands:'));
assert(helpCli.includes('lloom up --go'));
assert(helpCli.includes('lloom up --json'));
assert(helpCli.includes('lloom help advanced'));
assert(helpCli.includes('lloom doctor'));
assert(helpCli.includes('lloom integrate'));
assert(!helpCli.includes('recipe-submit <pack-file-or-url>'));
const helpFlagCli = (await runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom.mjs'), '--help']))
  .stdout;
assert(helpFlagCli.includes('Preview the best setup for this machine'));
const advancedHelpCli = (
  await runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'help', 'advanced'])
).stdout;
assert(advancedHelpCli.includes('lloom [--recipe id]'));
assert(advancedHelpCli.includes('recipe-submit <pack-file-or-url>'));
assert(advancedHelpCli.includes('runtime-admit <runtime-id>'));
const hostHelpCli = (
  await runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom-host.mjs'), 'serve', '--help'])
).stdout;
assert(hostHelpCli.includes('lloom-host serve'));
const registryCli = JSON.parse(
  (await runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'interchange', 'registry'])).stdout
);
assert.equal(registryCli.$schema, 'https://lloom.dev/schemas/interchange-registry.v1.schema.json');
assert(registryCli.documents.some((document) => document.kind === 'benchmarkSuite'));
assert(registryCli.documents.some((document) => document.mediaType === VALIDATION_REPORT_MEDIA_TYPE));
const exportedImportPlan = await createRecipePackPlan(exportPath, config, {
  indexPath: path.join(tempDir, 'export-import-recipes', 'index.json'),
  recipesRoot: path.join(tempDir, 'export-import-recipes'),
  benchmarksRoot: path.join(tempDir, 'export-import-benchmarks')
});
assert.equal(exportedImportPlan.ok, true);
const exportCliPath = path.join(tempDir, 'apple-silicon-qwen36-export-cli.json');
const exportCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'recipe-export',
  'apple-silicon-qwen36',
  '--output',
  exportCliPath,
  '--id',
  'apple-silicon-qwen36-cli-pack',
  '--apply',
  '--yes'
]);
const exportCliJson = JSON.parse(exportCli.stdout);
assert.equal(exportCliJson.dryRun, false);
assert.equal(exportCliJson.pack.id, 'apple-silicon-qwen36-cli-pack');
assert.equal(JSON.parse(await fs.readFile(exportCliPath, 'utf8')).id, 'apple-silicon-qwen36-cli-pack');
const recipeSubmitPlan = await submitRecipePack(exportPath, config, {
  hostUrl: 'http://127.0.0.1:8110'
});
assert.equal(recipeSubmitPlan.dryRun, true);
assert.equal(recipeSubmitPlan.ok, true);
assert.equal(recipeSubmitPlan.pack.id, 'apple-silicon-qwen36-pack');
assert.equal(recipeSubmitPlan.request.mediaType, 'application/vnd.lloom.recipe-pack+json;version=1');
assert.equal(recipeSubmitPlan.host.submissionPath, '/v1/recipe-packs');
await assert.rejects(
  () =>
    submitRecipePack(exportPath, config, {
      hostUrl: 'http://127.0.0.1:8110',
      dryRun: false
    }),
  /Refusing to submit recipe pack/
);
const recipeSubmitCliPlan = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'recipe-submit',
      exportPath,
      '--host',
      'http://127.0.0.1:8110'
    ])
  ).stdout
);
assert.equal(recipeSubmitCliPlan.dryRun, true);
assert.equal(recipeSubmitCliPlan.ok, true);
assert.equal(recipeSubmitCliPlan.pack.id, 'apple-silicon-qwen36-pack');

const derivedConfig = deriveUserConfig(config, recipe, {
  modelRoot: '/models'
});
const envTemplatePath = path.join(tempDir, 'env-template-config.json');
await fs.writeFile(
  envTemplatePath,
  JSON.stringify({
    security: {
      apiKeys: ['${LLOOM_API_KEY}'],
      adminApiKeys: ['${LLOOM_ADMIN_API_KEY}']
    },
    backends: {},
    models: []
  })
);
const envTemplateConfig = await loadConfig(envTemplatePath, {
  env: { ...process.env, LLOOM_API_KEY: 'resolved-user-key', LLOOM_ADMIN_API_KEY: 'resolved-admin-key' }
});
const envTemplateDerived = deriveUserConfig(envTemplateConfig, recipe, { modelRoot: '/models' });
assert.deepEqual(envTemplateDerived.security.apiKeys, ['${LLOOM_API_KEY}']);
assert.deepEqual(envTemplateDerived.security.adminApiKeys, ['${LLOOM_ADMIN_API_KEY}']);
assert.equal(
  config.runtimes['mtplx-qwen36-27b-speed'].args.at(2),
  path.join(defaultUserModelRoot(), 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed')
);
assert.equal(derivedConfig.sourcePath, undefined);
assert.equal(derivedConfig.runtimes['mtplx-qwen36-27b-speed'].enabled, true);
assert.equal(
  derivedConfig.runtimes['mtplx-qwen36-27b-speed'].args.at(2),
  '/models/Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed'
);
assert.equal(derivedConfig.runtimes['mtplx-qwen36-35b-a3b-speed-fp16'].keepWarm, true);
assert.equal(derivedConfig.runtimes['mtplx-qwen36-27b-speed'].args.includes('--ssd-session-cache'), false);
const embeddingRecipe = await loadRecipeById('linux-nvidia-qwen3-embedding-4b-vllm');
const additiveBase = {
  ...config,
  defaults: { ...(config.defaults ?? {}), chatModel: 'existing-chat' },
  models: [{ id: 'existing-chat', name: 'Existing chat', kind: 'chat', backend: 'existing-backend' }],
  backends: { ...(config.backends ?? {}), 'existing-backend': { baseUrl: 'http://127.0.0.1:8999/v1' } },
  runtimes: { ...(config.runtimes ?? {}), 'existing-runtime': { enabled: true, port: 8999, keepWarm: true } }
};
const additiveDerived = deriveUserConfig(additiveBase, embeddingRecipe, {
  modelRoot: '/models',
  additive: true
});
assert.equal(additiveDerived.defaults.chatModel, 'existing-chat');
assert.deepEqual(additiveDerived.models.map((model) => model.id).sort(), ['Qwen/Qwen3-Embedding-4B', 'existing-chat']);
assert.equal(additiveDerived.runtimes['existing-runtime'].keepWarm, true);
assert.equal(additiveDerived.runtimes['qwen3-embedding-4b'].keepWarm, true);
assert(additiveDerived.clientCatalog.modelOrder.includes('existing-chat'));
assert(additiveDerived.clientCatalog.modelOrder.includes('Qwen/Qwen3-Embedding-4B'));
assert(
  additiveDerived.clientCatalog.modelOrder.indexOf('existing-chat') <
    additiveDerived.clientCatalog.modelOrder.indexOf('Qwen/Qwen3-Embedding-4B')
);
assert.equal(additiveDerived.models.find((model) => model.id === 'Qwen/Qwen3-Embedding-4B').kind, 'embedding');
assert.equal(additiveDerived.runtimes['qwen3-embedding-4b'].adapter, 'docker');
const retunedEmbeddingRecipe = structuredClone(embeddingRecipe);
retunedEmbeddingRecipe.models[0].settings.memoryGb = 13;
const retunedDerived = deriveUserConfig(additiveDerived, retunedEmbeddingRecipe, {
  modelRoot: '/models',
  additive: true
});
assert.equal(retunedDerived.runtimes['qwen3-embedding-4b'].memoryGb, 13);
const singleModelRecipe = await loadRecipeById(
  'apple-silicon-qwen36-35b-a3b-mtplx',
  path.join(process.cwd(), 'community', 'recipes')
);
const singleModelDerivedConfig = deriveUserConfig(config, singleModelRecipe, {
  modelRoot: '/models'
});
const singleModelRegistry = createRegistry({
  ...singleModelDerivedConfig,
  clientCatalog: {
    includeAliases: true
  }
});
const singleAdvertisedModels = singleModelRegistry.openAIModels().map((model) => model.id);
assert.deepEqual(singleAdvertisedModels, ['Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16']);
assert.equal(singleModelDerivedConfig.defaults.chatModel, 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16');
assert.equal(singleModelDerivedConfig.defaults.imageModel, undefined);
assert.equal(singleModelDerivedConfig.defaults.speechModel, undefined);
const singleClientModels = singleModelRegistry.clientModels().map((model) => model.id);
assert(singleClientModels.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));
assert(singleClientModels.includes('qwen36-35b-fastest'));
assert(!singleClientModels.includes('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
assert(!singleClientModels.includes('qwen36-27b-fastest'));
const portableRecipe = {
  schemaVersion: 1,
  id: 'portable-community-mtplx',
  name: 'Portable Community MTPLX',
  version: 1,
  requirements: {
    platforms: [`${process.platform}-${process.arch}`],
    memoryGb: 1,
    accelerators: process.platform === 'darwin' ? ['apple-gpu'] : []
  },
  backend: {
    id: 'mtplx'
  },
  models: [
    {
      role: 'default',
      model: 'Example/Portable-MTPLX-Speed',
      gatewayModel: 'Example/Portable-MTPLX-Speed',
      runtime: 'mtplx-portable-community-speed',
      capabilities: ['chat', 'streaming', 'usage', 'tools', 'reasoning', 'mtp', 'long-context'],
      settings: {
        profile: 'turbo',
        draftDepth: 2,
        contextWindow: 65536,
        maxOutputTokens: 4096,
        maxActiveRequests: 7,
        memoryGb: 12,
        sessionCache: true,
        runtime: {
          command: 'mtplx',
          args: [
            'serve',
            '--model',
            '${modelPath}',
            '--host',
            '127.0.0.1',
            '--port',
            '${port}',
            '--model-id',
            '${modelId}',
            '--profile',
            'turbo',
            '--depth',
            '2',
            '--context-window',
            '65536',
            '--max-tokens',
            '4096',
            '--reasoning',
            'auto',
            '--preserve-thinking',
            'auto',
            '--batching-preset',
            'agent',
            '--max-active-requests',
            '7',
            '--no-stats-footer'
          ],
          adapter: 'mtplx',
          baseUrlPath: '/v1',
          healthPath: '/health',
          warmupPath: '/v1/chat/completions'
        }
      }
    }
  ]
};
const minimalDataDrivenConfig = structuredClone(config);
minimalDataDrivenConfig.defaults = {};
minimalDataDrivenConfig.backends = {};
minimalDataDrivenConfig.runtimes = {};
minimalDataDrivenConfig.models = [];
minimalDataDrivenConfig.aliases = {};
minimalDataDrivenConfig.clientCatalog = {
  providerId: 'local-llm',
  providerName: 'LLooM Local',
  modelOrder: []
};
const portableDerivedConfig = deriveUserConfig(minimalDataDrivenConfig, portableRecipe, {
  modelRoot: '/models',
  sessionCacheRoot: '/sessions'
});
assert.equal(portableDerivedConfig.defaults.chatModel, 'Example/Portable-MTPLX-Speed');
assert.equal(portableDerivedConfig.runtimes['mtplx-portable-community-speed'].keepWarm, true);
assert.equal(portableDerivedConfig.models.length, 1);
assert.equal(portableDerivedConfig.models[0].backend, 'mtplx-example-portable-mtplx-speed');
assert.equal(portableDerivedConfig.models[0].contextWindow, 65536);
assert.equal(portableDerivedConfig.models[0].maxOutputTokens, 4096);
assert.equal(portableDerivedConfig.clientCatalog.modelOrder[0], 'Example/Portable-MTPLX-Speed');
assert.equal(portableDerivedConfig.backends['mtplx-example-portable-mtplx-speed'].baseUrl, 'http://127.0.0.1:8201/v1');
assert.equal(portableDerivedConfig.runtimes['mtplx-portable-community-speed'].port, 8201);
assert.equal(portableDerivedConfig.runtimes['mtplx-portable-community-speed'].memoryGb, 12);
assert.equal(
  portableDerivedConfig.runtimes['mtplx-portable-community-speed'].sessionCache.dir,
  '/sessions/mtplx-portable-community-speed'
);
assert.deepEqual(portableDerivedConfig.runtimes['mtplx-portable-community-speed'].args, [
  'serve',
  '--model',
  '/models/Example--Portable-MTPLX-Speed',
  '--host',
  '127.0.0.1',
  '--port',
  '8201',
  '--model-id',
  'Example/Portable-MTPLX-Speed',
  '--profile',
  'turbo',
  '--depth',
  '2',
  '--context-window',
  '65536',
  '--max-tokens',
  '4096',
  '--reasoning',
  'auto',
  '--preserve-thinking',
  'auto',
  '--batching-preset',
  'agent',
  '--max-active-requests',
  '7',
  '--no-stats-footer'
]);
assert.deepEqual(
  createRegistry(portableDerivedConfig)
    .openAIModels()
    .map((model) => model.id),
  ['Example/Portable-MTPLX-Speed']
);
const portableSglangRecipe = {
  schemaVersion: 1,
  id: 'portable-community-sglang',
  name: 'Portable Community SGLang',
  version: 1,
  requirements: {
    platforms: [`${process.platform}-${process.arch}`],
    memoryGb: 1
  },
  backend: {
    id: 'sglang'
  },
  models: [
    {
      role: 'default',
      model: 'Example/Portable-SGLang-Chat',
      gatewayModel: 'Example/Portable-SGLang-Chat',
      runtime: 'sglang-portable-community-chat',
      capabilities: ['chat', 'streaming', 'usage', 'tools', 'long-context'],
      settings: {
        contextWindow: 65536,
        maxOutputTokens: 4096,
        maxActiveRequests: 8,
        memoryGb: 24
      }
    }
  ]
};
const portableSglangConfig = deriveUserConfig(minimalDataDrivenConfig, portableSglangRecipe, {
  modelRoot: '/models'
});
assert.equal(portableSglangConfig.defaults.chatModel, 'Example/Portable-SGLang-Chat');
assert.equal(portableSglangConfig.runtimes['sglang-portable-community-chat'].keepWarm, true);
assert.equal(portableSglangConfig.runtimes['sglang-portable-community-chat'].command, 'sglang-python');
assert.equal(portableSglangConfig.runtimes['sglang-portable-community-chat'].maxConcurrency, 8);
assert.equal(portableSglangConfig.runtimes['sglang-portable-community-chat'].memoryGb, 24);
assert.deepEqual(portableSglangConfig.runtimes['sglang-portable-community-chat'].args, [
  '-m',
  'sglang.launch_server',
  '--model-path',
  '/models/Example--Portable-SGLang-Chat',
  '--host',
  '127.0.0.1',
  '--port',
  '8201',
  '--served-model-name',
  'Example/Portable-SGLang-Chat',
  '--tp',
  '1',
  '--context-length',
  '65536',
  '--mem-fraction-static',
  '0.85',
  '--trust-remote-code'
]);
assert.equal(
  portableSglangConfig.runtimes['sglang-portable-community-chat'].warmup.url,
  'http://127.0.0.1:8201/v1/chat/completions'
);
const mtplxEffectiveArgs = effectiveRuntimeArgs(
  'mtplx-qwen36-27b-speed',
  derivedConfig.runtimes['mtplx-qwen36-27b-speed']
);
const mtplxCacheFlagIndex = mtplxEffectiveArgs.indexOf('--ssd-session-cache');
assert(mtplxCacheFlagIndex > -1);
assert.equal(mtplxEffectiveArgs[mtplxCacheFlagIndex + 1], 'on');
assert(mtplxEffectiveArgs.includes('--ssd-session-cache-dir'));
assert(mtplxEffectiveArgs.includes(path.join(defaultUserSessionCacheRoot(), 'mtplx-qwen36-27b-speed')));
assert(mtplxEffectiveArgs.includes('--ssd-session-cache-max-size'));
assert(mtplxEffectiveArgs.includes('100GB'));
assert(mtplxEffectiveArgs.includes('--ssd-session-cache-min-prefix-tokens'));
assert(mtplxEffectiveArgs.includes('512'));
assert.deepEqual(
  effectiveRuntimeArgs('mtplx-disabled-cache', {
    command: 'mtplx',
    args: ['serve'],
    sessionCache: { enabled: false }
  }),
  ['serve', '--ssd-session-cache', 'off']
);
assert.throws(
  () =>
    effectiveRuntimeArgs('unsupported-cache', {
      command: '/usr/bin/true',
      args: [],
      sessionCache: { mode: 'on' }
    }),
  /sessionCache is not supported/
);
const llamaCppCacheRuntime = {
  command: 'llama-server',
  args: ['--model', '/models/test.gguf', '--host', '127.0.0.1', '--port', '8201', '--ctx-size', '32768'],
  sessionCache: {
    kind: 'llama-cpp-kv-cache',
    mode: 'on',
    dir: path.join(defaultUserSessionCacheRoot(), 'llama-cpp-test'),
    minPrefixTokens: 256
  }
};
const llamaCppEffectiveArgs = effectiveRuntimeArgs('llama-cpp-test', llamaCppCacheRuntime);
assert(llamaCppEffectiveArgs.includes('--cache-prompt'));
assert(llamaCppEffectiveArgs.includes('--cache-reuse'));
assert(llamaCppEffectiveArgs.includes('256'));
assert(llamaCppEffectiveArgs.includes('--slot-save-path'));
assert(llamaCppEffectiveArgs.includes(path.join(defaultUserSessionCacheRoot(), 'llama-cpp-test')));
assert.deepEqual(
  effectiveRuntimeArgs('llama-cpp-off', {
    command: 'llama-server',
    args: ['--model', '/models/test.gguf'],
    sessionCache: { kind: 'llama-cpp-kv-cache', mode: 'off' }
  }),
  ['--model', '/models/test.gguf', '--no-cache-prompt']
);
const llamaCppWriteOnlyArgs = effectiveRuntimeArgs('llama-cpp-write', {
  command: 'llama-server',
  args: ['--model', '/models/test.gguf'],
  sessionCache: { kind: 'llama-cpp-kv-cache', mode: 'write-only', dir: '/cache/llama' }
});
assert(llamaCppWriteOnlyArgs.includes('--cache-prompt'));
assert(llamaCppWriteOnlyArgs.includes('--slot-save-path'));
assert(!llamaCppWriteOnlyArgs.includes('--cache-reuse'));
const portedConfig = deriveUserConfig(config, recipe, {
  modelRoot: '/models',
  gatewayPort: 9100,
  backendPortRange: '9200-9209'
});
assert.equal(portedConfig.server.port, 9100);
assert.equal(portedConfig.providers['local-llm'].baseUrl, 'http://127.0.0.1:9100/v1');
assert.equal(portedConfig.runtimes['mtplx-qwen36-27b-speed'].port, 9200);
assert.equal(portedConfig.runtimes['mtplx-qwen36-27b-speed'].args.at(6), '9200');
assert.equal(portedConfig.runtimes['mtplx-qwen36-27b-speed'].healthUrl, 'http://127.0.0.1:9200/health');
assert.equal(portedConfig.runtimes['mtplx-qwen36-27b-speed'].warmup.url, 'http://127.0.0.1:9200/v1/chat/completions');
assert.equal(portedConfig.backends['mtplx-27b'].baseUrl, 'http://127.0.0.1:9200/v1');
assert.equal(portedConfig.runtimes['mtplx-qwen36-35b-a3b-speed-fp16'].port, 9201);
assert.equal(portedConfig.backends['mtplx-35b-a3b'].baseUrl, 'http://127.0.0.1:9201/v1');
assert.deepEqual(portedConfig.ports.backends.assigned, {
  'mtplx-qwen36-27b-speed': 9200,
  'mtplx-qwen36-35b-a3b-speed-fp16': 9201
});
assert.throws(
  () =>
    deriveUserConfig(config, recipe, {
      modelRoot: '/models',
      backendPortRange: '9200-9200'
    }),
  /recipe runtimes need ports/
);

const initPlan = await createInitPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'config.json'),
  modelRoot: '/models',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'generated'),
  clientId: 'omp',
  backendVariables: {
    shimDir: path.join(tempDir, 'init-bin'),
    backendRoot: path.join(tempDir, 'backends'),
    installRoot: path.join(tempDir, 'install'),
    repoParent: path.dirname(process.cwd()),
    modelRoot: '/models'
  }
});
assert.equal(initPlan.dryRun, true);
assert.equal(initPlan.configPath, path.join(tempDir, 'config.json'));
assert.equal(initPlan.sessionCacheRoot, path.join(tempDir, '.lloom', 'session-cache'));
assert.deepEqual(initPlan.keepWarm, ['mtplx-qwen36-35b-a3b-speed-fp16']);
assert.deepEqual(
  initPlan.integrations.map((integration) => integration.id),
  ['omp-models', 'omp-config']
);
assert.equal(initPlan.config.runtimes['mtplx-qwen36-27b-speed'].enabled, true);
assert.equal(
  initPlan.config.runtimes['mtplx-qwen36-27b-speed'].sessionCache.dir,
  path.join(tempDir, '.lloom', 'session-cache', 'mtplx-qwen36-27b-speed')
);
assert(initPlan.next.apply.includes("--model-root '/models'"));
assert(initPlan.next.apply.includes("--client 'omp'"));

const imageRecipe = await loadRecipeById('high-memory-local-image-generation');
const imageConfig = deriveUserConfig(config, imageRecipe, { modelRoot: '/models' });
assert(
  imageConfig.runtimes['flux2-klein-4b-sdcpp'].args.includes('/models/lloom-flux2-klein-4b/flux-2-klein-4b-Q8_0.gguf')
);
assert(
  imageConfig.runtimes['qwen-image-2512-sdcpp'].args.includes('/models/lloom-qwen-image-2512/qwen-image-2512-Q8_0.gguf')
);
assert.equal(imageConfig.runtimes['flux2-klein-4b-sdcpp'].keepWarm, false);

const sparkRecipe = await loadRecipeById('linux-nvidia-gb10-qwen36-unsloth-vllm');
const sparkConfig = deriveUserConfig(config, sparkRecipe, { modelRoot: '/models' });
assert.equal(sparkConfig.runtimes['unsloth-qwen36-35b-a3b-nvfp4'].adapter, 'docker');
assert.equal(sparkConfig.runtimes['unsloth-qwen36-35b-a3b-nvfp4'].keepWarm, false);
assert.equal(sparkConfig.runtimes['unsloth-qwen36-27b-nvfp4'].keepWarm, false);

const initPlanWithDefaultModelRoot = await createInitPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'generated-default-root'),
  clientId: 'omp'
});
assert.equal(initPlanWithDefaultModelRoot.configPath, path.join(tempDir, '.lloom', 'config.json'));
assert.equal(initPlanWithDefaultModelRoot.modelRoot, path.join(tempDir, '.lloom', 'models'));
assert.equal(initPlanWithDefaultModelRoot.sessionCacheRoot, path.join(tempDir, '.lloom', 'session-cache'));
assert.equal(
  initPlanWithDefaultModelRoot.config.runtimes['mtplx-qwen36-27b-speed'].args.at(2),
  path.join(tempDir, '.lloom', 'models', 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed')
);
assert.equal(
  initPlanWithDefaultModelRoot.config.runtimes['mtplx-qwen36-27b-speed'].sessionCache.dir,
  path.join(tempDir, '.lloom', 'session-cache', 'mtplx-qwen36-27b-speed')
);

const detectedModelRoot = path.join(tempDir, 'detected-models');
for (const modelDir of [
  'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed',
  'Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'
]) {
  await fs.mkdir(path.join(detectedModelRoot, modelDir), { recursive: true });
  await fs.writeFile(path.join(detectedModelRoot, modelDir, 'model-00001-of-00001.safetensors'), 'weights\n', 'utf8');
}
const previousModelRootEnv = process.env.LLOOM_MODEL_ROOT;
process.env.LLOOM_MODEL_ROOT = detectedModelRoot;
try {
  const initPlanWithDetectedModelRoot = await createInitPlan(config, {
    recipeId: 'apple-silicon-qwen36',
    home: tempDir,
    generatedRoot: path.join(tempDir, 'generated-detected-root'),
    clientId: 'omp',
    autoDetectModelRoot: true
  });
  assert.equal(initPlanWithDetectedModelRoot.modelRoot, detectedModelRoot);
  assert.equal(initPlanWithDetectedModelRoot.modelRootDetected, true);
  assert.equal(
    initPlanWithDetectedModelRoot.config.runtimes['mtplx-qwen36-27b-speed'].args.at(2),
    path.join(detectedModelRoot, 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed')
  );
} finally {
  if (previousModelRootEnv == null) {
    delete process.env.LLOOM_MODEL_ROOT;
  } else {
    process.env.LLOOM_MODEL_ROOT = previousModelRootEnv;
  }
}

await assert.rejects(
  () =>
    applyInit(config, {
      dryRun: false,
      configPath: path.join(tempDir, 'refuse-config.json'),
      modelRoot: '/models',
      home: tempDir,
      generatedRoot: path.join(tempDir, 'generated-refuse')
    }),
  /Refusing to initialize LLooM/
);

const initApply = await applyInit(config, {
  dryRun: false,
  yes: true,
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'applied-config.json'),
  modelRoot: '/models',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'generated-applied'),
  clientId: 'omp'
});
assert.equal(initApply.dryRun, false);
const appliedConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'applied-config.json'), 'utf8'));
assert.equal(appliedConfig.runtimes['mtplx-qwen36-27b-speed'].enabled, true);
assert.equal(appliedConfig.runtimes['mtplx-qwen36-35b-a3b-speed-fp16'].keepWarm, true);
const initGeneratedOmp = await fs.readFile(path.join(tempDir, 'generated-applied', 'omp-models.yml'), 'utf8');
assert(initGeneratedOmp.includes('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
const initGeneratedOmpConfig = await fs.readFile(path.join(tempDir, 'generated-applied', 'omp-config.yml'), 'utf8');
assert(initGeneratedOmpConfig.includes('default: local-llm/Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16:low'));
await assert.rejects(() => fs.access(path.join(tempDir, 'generated-applied', 'opencode.json')), /ENOENT/);
assert.equal(initApply.written.integrations.results[0].status, 'not-applied');

const runtimePort = await allocatePort();
if (runtimePort) {
  const runtimeScript = path.join(tempDir, 'synthetic-runtime.mjs');
  await fs.writeFile(
    runtimeScript,
    `
import http from "node:http";

const port = Number(process.argv[2]);
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_synthetic",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    'utf8'
  );
  const lifecycleConfig = {
    runtimePolicy: { enabled: true, autoEvict: true, memoryBudgetGb: 10 },
    runtimes: {
      'synthetic-runtime': {
        enabled: true,
        keepWarm: true,
        memoryGb: 1,
        command: process.execPath,
        args: [runtimeScript, String(runtimePort)],
        port: runtimePort,
        healthUrl: `http://127.0.0.1:${runtimePort}/health`,
        startupTimeoutMs: 5000,
        warmup: {
          url: `http://127.0.0.1:${runtimePort}/v1/chat/completions`,
          body: {
            model: 'synthetic',
            messages: [{ role: 'user', content: 'warm up' }],
            max_tokens: 1
          }
        }
      }
    }
  };
  const lifecycleManager = new RuntimeManager(lifecycleConfig, {
    logger: { error() {} }
  });
  const priorityManager = new RuntimeManager({
    runtimes: {
      normal: { keepWarm: true, priority: 100 },
      firstHigh: { keepWarm: true, policy: { priority: 300 } },
      secondHigh: { keepWarm: true, policy: { priority: 300 } },
      low: { keepWarm: true, priority: 10 }
    }
  });
  assert.deepEqual(priorityManager.keepWarmRuntimeIds(), ['firstHigh', 'secondHigh', 'normal', 'low']);
  const admissionWarnings = [];
  const constrainedKeepWarmManager = new RuntimeManager(
    {
      runtimePolicy: { memoryBudgetGb: 1 },
      runtimes: {
        tooLargeFirst: { enabled: true, keepWarm: true, memoryGb: 3, priority: 200 },
        tooLargeSecond: { enabled: true, keepWarm: true, memoryGb: 2, priority: 100 }
      }
    },
    {
      logger: {
        warn(message) {
          admissionWarnings.push(message);
        }
      }
    }
  );
  const constrainedKeepWarmResult = await constrainedKeepWarmManager.startKeepWarm();
  assert.equal(constrainedKeepWarmResult.length, 2);
  assert(constrainedKeepWarmResult.every((result) => result.reason === 'insufficient-memory'));
  assert.equal(admissionWarnings.length, 2);
  const startResult = await lifecycleManager.ensure('synthetic-runtime');
  assert.equal(startResult.started, true);
  assert.equal(startResult.healthy, true);
  assert.equal(startResult.warmup.warmed, true);
  const lifecycleStatus = await lifecycleManager.status();
  assert.equal(lifecycleStatus.runtimes['synthetic-runtime'].status, 'running');
  assert.equal(lifecycleStatus.runtimes['synthetic-runtime'].healthy, true);
  assert.equal(lifecycleStatus.runtimes['synthetic-runtime'].keepWarm, true);
  assert.equal(lifecycleStatus.runtimes['synthetic-runtime'].lastWarmup.warmed, true);
  const warmupAgain = await lifecycleManager.warmupById('synthetic-runtime');
  assert.equal(warmupAgain.warmed, true);
  const keepWarmResult = await lifecycleManager.startKeepWarm();
  assert.equal(keepWarmResult[0].dryRun, false);
  assert.equal(keepWarmResult[0].plan.requestedRuntimeId, 'synthetic-runtime');
  assert.equal(keepWarmResult[0].results[0].result.reason, 'already-healthy');
  const stopResult = await lifecycleManager.stop('synthetic-runtime');
  assert.equal(stopResult.stopped, true);

  const adoptedDockerManager = new RuntimeManager({
    runtimes: {
      adopted: {
        adapter: 'docker',
        management: 'external',
        containerName: 'must-not-be-touched',
        port: 65534
      }
    }
  });
  const adoptedStart = await adoptedDockerManager.start('adopted');
  assert.deepEqual(adoptedStart, {
    runtimeId: 'adopted',
    started: false,
    healthy: false,
    reason: 'externally-managed'
  });
  const adoptedStop = await adoptedDockerManager.stop('adopted');
  assert.deepEqual(adoptedStop, {
    runtimeId: 'adopted',
    stopped: false,
    reason: 'externally-managed'
  });

  assert.deepEqual(
    dockerCreateArgs({
      containerName: 'qwen-fast',
      bootstrap: {
        adapter: 'docker',
        image: 'vllm/vllm-openai:v0.24.0',
        createArgs: ['--restart', 'unless-stopped', '-p', '8001:8000'],
        command: ['unsloth/Qwen3.6-35B-A3B-NVFP4-Fast', '--port', '8000']
      }
    }),
    [
      'create',
      '--name',
      'qwen-fast',
      '--restart',
      'unless-stopped',
      '-p',
      '8001:8000',
      'vllm/vllm-openai:v0.24.0',
      'unsloth/Qwen3.6-35B-A3B-NVFP4-Fast',
      '--port',
      '8000'
    ]
  );

  const behaviorOverrideArgs = dockerCreateArgs({
    containerName: 'qwen-corrected',
    behaviorOverrides: { chatTemplate: 'qwen3-xml-tool-reminder' },
    bootstrap: {
      adapter: 'docker',
      image: 'vllm/vllm-openai:v0.24.0',
      command: ['unsloth/Qwen3.6-35B-A3B-NVFP4', '--port', '8000']
    }
  });
  assert(behaviorOverrideArgs.includes('--mount'));
  assert(
    behaviorOverrideArgs.some((arg) => arg.includes('qwen3-xml-tool-reminder.jinja') && arg.endsWith(',readonly'))
  );
  assert.deepEqual(behaviorOverrideArgs.slice(-2), ['--chat-template', '/etc/lloom/chat-template.jinja']);
  assert.throws(
    () =>
      dockerCreateArgs({
        containerName: 'invalid-correction',
        behaviorOverrides: { chatTemplate: 'not-installed' },
        bootstrap: { image: 'example.invalid/vllm' }
      }),
    /unknown chat template behavior override/
  );

  const limiterManager = new RuntimeManager(
    {
      runtimes: {
        limited: {
          maxConcurrency: 1
        }
      }
    },
    {
      logger: { error() {} }
    }
  );
  let active = 0;
  let maxActive = 0;
  const order = [];
  const jobs = [1, 2, 3].map((index) =>
    limiterManager.withSlot('limited', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${index}`);
      await wait(20);
      order.push(`end-${index}`);
      active -= 1;
      return index;
    })
  );
  await wait(1);
  const limiterStatus = await limiterManager.status();
  assert.equal(limiterStatus.runtimes.limited.maxConcurrency, 1);
  assert.equal(limiterStatus.runtimes.limited.activeRequests, 1);
  assert.equal(limiterStatus.runtimes.limited.queuedRequests, 2);
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  const limiterDoneStatus = await limiterManager.status();
  assert.equal(limiterDoneStatus.runtimes.limited.activeRequests, 0);
  assert.equal(limiterDoneStatus.runtimes.limited.queuedRequests, 0);

  const lifecycleLockManager = new RuntimeManager(
    {
      runtimes: {
        locked: {
          enabled: true
        }
      }
    },
    {
      logger: { error() {} }
    }
  );
  let lifecycleActive = 0;
  let lifecycleMaxActive = 0;
  const lifecycleOrder = [];
  const lifecycleOperation = async (label) => {
    lifecycleActive += 1;
    lifecycleMaxActive = Math.max(lifecycleMaxActive, lifecycleActive);
    lifecycleOrder.push(`start-${label}`);
    await wait(10);
    lifecycleOrder.push(`end-${label}`);
    lifecycleActive -= 1;
  };
  lifecycleLockManager.startUnlocked = async (runtimeId) => {
    await lifecycleOperation('start');
    return { runtimeId, started: true };
  };
  lifecycleLockManager.stopUnlocked = async (runtimeId) => {
    await lifecycleOperation('stop');
    return { runtimeId, stopped: true };
  };
  await Promise.all([lifecycleLockManager.start('locked'), lifecycleLockManager.stop('locked')]);
  assert.equal(lifecycleMaxActive, 1);
  assert.deepEqual(lifecycleOrder, ['start-start', 'end-start', 'start-stop', 'end-stop']);

  const cliConfigPath = path.join(tempDir, 'runtime-cli-config.json');
  await fs.writeFile(cliConfigPath, `${JSON.stringify(lifecycleConfig, null, 2)}\n`, 'utf8');
  const runLLooM = async (args) =>
    runCommand(process.execPath, [path.join(process.cwd(), 'bin', 'lloom.mjs'), ...args, '--config', cliConfigPath]);

  const cliStatus = JSON.parse((await runLLooM(['runtimes', 'synthetic-runtime'])).stdout);
  assert.equal(cliStatus.runtimes['synthetic-runtime'].healthy, false);
  assert.equal(cliStatus.runtimes['synthetic-runtime'].keepWarm, true);

  const cliRuntimePlan = JSON.parse((await runLLooM(['runtime-plan', 'synthetic-runtime'])).stdout);
  assert.equal(cliRuntimePlan.requestedRuntimeId, 'synthetic-runtime');
  assert(cliRuntimePlan.actions.some((action) => action.type === 'start' && action.runtimeId === 'synthetic-runtime'));

  const cliRuntimeAdmit = JSON.parse((await runLLooM(['runtime-admit', 'synthetic-runtime'])).stdout);
  assert.equal(cliRuntimeAdmit.dryRun, true);
  assert(cliRuntimeAdmit.results.some((result) => result.type === 'start' && result.status === 'planned'));

  const cliStart = JSON.parse((await runLLooM(['runtime-start', 'synthetic-runtime'])).stdout);
  assert.equal(cliStart.started, true);
  assert.equal(cliStart.healthy, true);
  assert.equal(cliStart.warmup.warmed, true);

  const cliWarmup = JSON.parse((await runLLooM(['runtime-warmup', 'synthetic-runtime'])).stdout);
  assert.equal(cliWarmup.warmed, true);

  const cliKeepWarm = JSON.parse((await runLLooM(['keep-warm'])).stdout);
  assert.equal(cliKeepWarm.results[0].plan.requestedRuntimeId, 'synthetic-runtime');
  assert.equal(cliKeepWarm.results[0].results[0].result.healthy, true);

  const cliRunningStatus = JSON.parse((await runLLooM(['runtimes', 'synthetic-runtime'])).stdout);
  assert.equal(cliRunningStatus.runtimes['synthetic-runtime'].healthy, true);
  assert.equal(cliRunningStatus.runtimes['synthetic-runtime'].status, 'external');

  const cliStop = JSON.parse((await runLLooM(['runtime-stop', 'synthetic-runtime'])).stdout);
  assert.equal(cliStop.stopped, true);

  await runLLooM(['runtime-start', 'synthetic-runtime']);
  const cliDown = JSON.parse((await runLLooM(['down', '--json'])).stdout);
  assert.equal(cliDown.gateway.status, 'not-running');
  assert.equal(cliDown.runtimes.stopped, 1);
  assert.equal(cliDown.runtimes.total, 1);
  assert.equal(cliDown.runtimes.results[0].runtimeId, 'synthetic-runtime');
}

const syntheticRecipe = {
  $schema: 'https://lloom.dev/schemas/recipe.v1.schema.json',
  schemaVersion: 1,
  id: 'synthetic',
  name: 'Synthetic',
  backend: {
    id: 'test'
  },
  models: [
    {
      role: 'test',
      model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      runtime: 'mtplx-qwen36-27b-speed'
    }
  ],
  setup: {
    steps: [
      {
        id: 'true',
        action: 'command',
        command: '/usr/bin/true'
      }
    ]
  }
};
const applied = await applyRecipe(syntheticRecipe, config, {
  dryRun: false,
  yes: true,
  statePath
});
assert.equal(applied.results[0].status, 'completed');
const appliedAgain = await applyRecipe(syntheticRecipe, config, {
  dryRun: false,
  yes: true,
  statePath
});
assert.equal(appliedAgain.results[0].status, 'skipped');

const hfShim = path.join(tempDir, 'hf');
const hfLogPath = path.join(tempDir, 'hf.log');
await fs.writeFile(
  hfShim,
  `#!/bin/sh
echo "$@" >> ${JSON.stringify(hfLogPath)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--local-dir" ]; then
    shift
    mkdir -p "$1"
    echo downloaded > "$1/config.json"
    echo weights > "$1/model-00001-of-00001.safetensors"
  fi
  shift
done
`,
  { mode: 0o755 }
);
await fs.chmod(hfShim, 0o755);
const previousHfBin = process.env.LLOOM_HF_BIN;
process.env.LLOOM_HF_BIN = hfShim;
try {
  const downloadRecipe = {
    $schema: 'https://lloom.dev/schemas/recipe.v1.schema.json',
    schemaVersion: 1,
    id: 'synthetic-download',
    name: 'Synthetic Download',
    backend: {
      id: 'test'
    },
    models: [
      {
        role: 'test',
        model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
        gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
        runtime: 'mtplx-qwen36-27b-speed'
      }
    ],
    setup: {
      steps: [
        {
          id: 'download',
          action: 'download-model',
          provider: 'huggingface',
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
        }
      ]
    }
  };
  const downloadModelRoot = path.join(tempDir, 'download-models');
  const downloadStatePath = path.join(tempDir, 'download-state.json');
  const downloadDryRun = await applyRecipe(downloadRecipe, config, {
    dryRun: true,
    yes: false,
    modelRoot: downloadModelRoot,
    statePath: downloadStatePath
  });
  assert.equal(downloadDryRun.results[0].status, 'planned');
  assert.equal(downloadDryRun.results[0].command[0], hfShim);
  const downloadApplied = await applyRecipe(downloadRecipe, config, {
    dryRun: false,
    yes: true,
    modelRoot: downloadModelRoot,
    statePath: downloadStatePath
  });
  assert.equal(downloadApplied.results[0].status, 'completed');
  assert.equal(downloadApplied.results[0].command[0], hfShim);
  assert.equal(
    await fs.readFile(
      path.join(downloadModelRoot, 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed', 'config.json'),
      'utf8'
    ),
    'downloaded\n'
  );

  process.env.LLOOM_HF_BIN = path.join(tempDir, 'missing-hf');
  const existingStatePath = path.join(tempDir, 'download-existing-state.json');
  const existingApplied = await applyRecipe(downloadRecipe, config, {
    dryRun: false,
    yes: true,
    modelRoot: downloadModelRoot,
    statePath: existingStatePath
  });
  assert.equal(existingApplied.results[0].status, 'skipped');
  assert.equal(existingApplied.results[0].reason, 'destination-populated');
  const existingState = await readInstallState(existingStatePath);
  assert.equal(existingState.recipes['synthetic-download'].steps.download.status, 'completed');
} finally {
  if (previousHfBin == null) {
    delete process.env.LLOOM_HF_BIN;
  } else {
    process.env.LLOOM_HF_BIN = previousHfBin;
  }
}

const syntheticBin = path.join(tempDir, 'synthetic-backend');
await fs.writeFile(syntheticBin, '#!/bin/sh\necho synthetic-ok\n', { mode: 0o755 });
await fs.chmod(syntheticBin, 0o755);
const syntheticBackend = {
  id: 'synthetic-backend',
  name: 'Synthetic Backend',
  kind: 'openai-compatible-server',
  platforms: [`${process.platform}-${process.arch}`],
  features: ['chat'],
  commands: ['synthetic-backend'],
  setup: [
    {
      id: 'link-synthetic',
      title: 'Link synthetic backend',
      action: 'link-command',
      commandName: 'synthetic-backend',
      sourceCandidates: [syntheticBin]
    },
    {
      id: 'skip-existing',
      title: 'Skip existing executable',
      action: 'command',
      command: 'node',
      args: ['--version'],
      skipIfExecutableExists: [syntheticBin]
    }
  ]
};
const backendStatePath = path.join(tempDir, 'backend-state.json');
const backendDryRun = await applyBackend(syntheticBackend, {
  dryRun: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, 'bin')
  }
});
assert.equal(backendDryRun.results[0].status, 'planned');
assert.equal(backendDryRun.results[0].audit.risk, 'medium');
assert(backendDryRun.results[0].audit.effects.includes('creates-shim'));
assert.equal(backendDryRun.results[1].status, 'skipped');
assert.equal(backendDryRun.results[1].reason, 'executable-exists');
assert.equal(backendDryRun.results[1].audit.effects[0], 'skipped');
await assert.rejects(
  () =>
    applyBackend(syntheticBackend, {
      dryRun: false,
      statePath: backendStatePath,
      variables: {
        shimDir: path.join(tempDir, 'bin')
      }
    }),
  /Refusing to modify backend setup/
);
const backendApplied = await applyBackend(syntheticBackend, {
  dryRun: false,
  yes: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, 'bin')
  }
});
assert.equal(backendApplied.results[0].status, 'completed');
assert.equal(backendApplied.results[1].status, 'skipped');
const shimPath = path.join(tempDir, 'bin', 'synthetic-backend');
const appliedBackendState = await readInstallState(backendStatePath);
assert.equal(appliedBackendState.backends['synthetic-backend'].steps['link-synthetic'].audit.risk, 'medium');
assert(appliedBackendState.backends['synthetic-backend'].steps['link-synthetic'].audit.writes.includes(shimPath));
const shimResult = await runCommand(shimPath, [], { allowFailure: true });
assert.equal(shimResult.code, 0);
assert.equal(shimResult.stdout.trim(), 'synthetic-ok');
const backendAppliedAgain = await applyBackend(syntheticBackend, {
  dryRun: false,
  yes: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, 'bin')
  }
});
assert.equal(backendAppliedAgain.results[0].status, 'skipped');
assert.equal(backendAppliedAgain.results[1].status, 'skipped');
await fs.rm(shimPath);
const backendRepaired = await applyBackend(syntheticBackend, {
  dryRun: false,
  yes: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, 'bin')
  }
});
assert.equal(backendRepaired.results[0].status, 'completed');
assert.equal((await runCommand(shimPath, [], { allowFailure: true })).stdout.trim(), 'synthetic-ok');
const missingLinkBackend = {
  ...syntheticBackend,
  id: 'synthetic-missing-link-backend',
  setup: [
    {
      id: 'link-missing',
      title: 'Link missing backend',
      action: 'link-command',
      commandName: 'missing-backend',
      sourceCandidates: [path.join(tempDir, 'does-not-exist')]
    }
  ]
};
const missingLinkApplied = await applyBackend(missingLinkBackend, {
  dryRun: false,
  yes: true,
  statePath: path.join(tempDir, 'missing-link-backend-state.json'),
  variables: {
    shimDir: path.join(tempDir, 'bin')
  }
});
assert.equal(missingLinkApplied.results[0].status, 'failed');
assert(missingLinkApplied.results[0].stderr.includes('No executable source found'));

const generatedOmp = await fs.readFile(path.join('clients', 'examples', 'omp-models.yml'), 'utf8');
assert(generatedOmp.includes('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
assert(generatedOmp.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));
assert(generatedOmp.includes('supportsUsageInStreaming: true'));
assert(!generatedOmp.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n'));
const generatedOmpConfig = await fs.readFile(path.join('clients', 'examples', 'omp-config.yml'), 'utf8');
assert(generatedOmpConfig.includes('default: local-llm/Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16:low'));
assert(!generatedOmpConfig.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n'));
const exampleClaudeProfile = await fs.readFile(path.join('clients', 'examples', 'claude.env'), 'utf8');
assert(exampleClaudeProfile.includes("ANTHROPIC_BASE_URL='http://127.0.0.1:8100'"));
assert(!exampleClaudeProfile.includes("ANTHROPIC_BASE_URL='http://127.0.0.1:8100/v1'"));
const exampleIntegrationManifest = JSON.parse(
  await fs.readFile(path.join('clients', 'examples', 'lloom-integrations.json'), 'utf8')
);
assert.equal(exampleIntegrationManifest.provider.gatewayUrl, 'http://127.0.0.1:8100');
assert.equal(exampleIntegrationManifest.provider.openAIBaseUrl, 'http://127.0.0.1:8100/v1');
assert.equal(exampleIntegrationManifest.provider.anthropicBaseUrl, 'http://127.0.0.1:8100');
assert.equal(exampleIntegrationManifest.provider.features.streamingUsage, true);
assert(
  exampleIntegrationManifest.clients
    .find((client) => client.id === 'opencode')
    .artifacts.some((artifact) => artifact.id === 'lloom-opencode')
);

const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-generated-'));
const integrationArtifacts = buildIntegrationArtifacts(config, registry, {
  home: tempDir,
  generatedRoot
});
assert.deepEqual(
  integrationArtifacts.map((artifact) => artifact.id),
  [
    'omp-models',
    'omp-config',
    'opencode',
    'lloom-opencode',
    'codex',
    'lloom-codex',
    'claude',
    'lloom-claude',
    'hermes',
    'lloom-hermes',
    'zero',
    'lloom-zero',
    'manifest'
  ]
);
assert(
  integrationArtifacts
    .filter((artifact) => artifact.kind !== 'launcher-script')
    .every((artifact) => artifact.content.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'))
);
assert(
  integrationArtifacts.every(
    (artifact) => !artifact.content.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n')
  )
);

await writeGeneratedIntegrationArtifacts(config, registry, {
  home: tempDir,
  generatedRoot
});
const generatedCodex = await fs.readFile(path.join(generatedRoot, 'codex.env'), 'utf8');
assert(generatedCodex.includes("LLOOM_GATEWAY_URL='http://127.0.0.1:8100'"));
assert(generatedCodex.includes("LLOOM_OPENAI_BASE_URL='http://127.0.0.1:8100/v1'"));
assert(generatedCodex.includes("LLOOM_ANTHROPIC_BASE_URL='http://127.0.0.1:8100'"));
assert(generatedCodex.includes("OPENAI_BASE_URL='http://127.0.0.1:8100/v1'"));
assert(generatedCodex.includes("OPENAI_MODEL='Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'"));
const generatedClaude = await fs.readFile(path.join(generatedRoot, 'claude.env'), 'utf8');
assert(generatedClaude.includes("OPENAI_BASE_URL='http://127.0.0.1:8100/v1'"));
assert(generatedClaude.includes("ANTHROPIC_BASE_URL='http://127.0.0.1:8100'"));
assert(!generatedClaude.includes("ANTHROPIC_BASE_URL='http://127.0.0.1:8100/v1'"));
const generatedCodexLauncher = await fs.readFile(path.join(generatedRoot, 'lloom-codex'), 'utf8');
assert(generatedCodexLauncher.includes('lloom integrate codex --apply --yes'));
assert.equal((await fs.stat(path.join(generatedRoot, 'lloom-codex'))).mode & 0o111, 0o111);
const generatedOpenCodeLauncher = await fs.readFile(path.join(generatedRoot, 'lloom-opencode'), 'utf8');
assert(generatedOpenCodeLauncher.includes('LLOOM_OPENCODE_BIN'));
assert(generatedOpenCodeLauncher.includes('--model'));
assert.equal((await fs.stat(path.join(generatedRoot, 'lloom-opencode'))).mode & 0o111, 0o111);
const generatedIntegrationManifest = JSON.parse(
  await fs.readFile(path.join(generatedRoot, 'lloom-integrations.json'), 'utf8')
);
assert.deepEqual(validateClientIntegrationManifest(generatedIntegrationManifest), []);
assert.equal(
  generatedIntegrationManifest.provider.defaultModel,
  'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'
);
assert.equal(generatedIntegrationManifest.provider.gatewayUrl, 'http://127.0.0.1:8100');
assert.equal(generatedIntegrationManifest.provider.openAIBaseUrl, 'http://127.0.0.1:8100/v1');
assert.equal(generatedIntegrationManifest.provider.anthropicBaseUrl, 'http://127.0.0.1:8100');
assert.equal(generatedIntegrationManifest.provider.features.streamingUsage, true);
assert(generatedIntegrationManifest.models.some((model) => model.capabilities.includes('mtp')));
const opencodeManifestClient = generatedIntegrationManifest.clients.find((client) => client.id === 'opencode');
assert(opencodeManifestClient.artifacts.some((artifact) => artifact.id === 'lloom-opencode'));
const generatedIntegrationValidation = await validateInterchangeDocument(generatedIntegrationManifest, config);
assert.equal(generatedIntegrationValidation.ok, true);
assert.equal(generatedIntegrationValidation.kind, 'clientIntegrations');

const codexIntegrationStatusBefore = await createClientIntegrationStatus(config, registry, {
  clientId: 'codex',
  home: tempDir,
  generatedRoot
});
assert.equal(codexIntegrationStatusBefore.ok, false);
assert.equal(codexIntegrationStatusBefore.summary.total, 2);
assert.equal(codexIntegrationStatusBefore.summary.missing, 2);
assert(codexIntegrationStatusBefore.data.every((artifact) => artifact.status === 'missing'));

const integrationDryRun = await applyIntegrationArtifacts(config, registry, {
  clientId: 'all',
  dryRun: true,
  home: tempDir,
  generatedRoot
});
assert(integrationDryRun.results.every((result) => result.status === 'planned'));

await assert.rejects(
  () =>
    applyIntegrationArtifacts(config, registry, {
      clientId: 'omp',
      dryRun: false,
      home: tempDir,
      generatedRoot
    }),
  /Refusing to modify client integration files/
);

const codexIntegrationApply = await applyIntegrationArtifacts(config, registry, {
  clientId: 'codex',
  dryRun: false,
  yes: true,
  home: tempDir,
  generatedRoot
});
assert.deepEqual(
  codexIntegrationApply.results.map((result) => result.id),
  ['codex', 'lloom-codex']
);
const installedCodexLauncher = path.join(tempDir, '.lloom', 'bin', 'lloom-codex');
assert.equal((await fs.stat(installedCodexLauncher)).mode & 0o111, 0o111);
assert((await fs.readFile(installedCodexLauncher, 'utf8')).includes('LLOOM_CODEX_BIN'));
const codexIntegrationStatusAfter = await createClientIntegrationStatus(config, registry, {
  clientId: 'codex',
  home: tempDir,
  generatedRoot
});
assert.equal(codexIntegrationStatusAfter.ok, true);
assert.equal(codexIntegrationStatusAfter.summary.current, 2);
assert(codexIntegrationStatusAfter.data.every((artifact) => artifact.current));
const opencodeTargetPath = path.join(tempDir, '.config', 'opencode', 'opencode.json');
await fs.mkdir(path.dirname(opencodeTargetPath), { recursive: true });
await fs.writeFile(opencodeTargetPath, '{"stale":true}\n', 'utf8');
const opencodeIntegrationApply = await applyIntegrationArtifacts(config, registry, {
  clientId: 'opencode',
  dryRun: false,
  yes: true,
  home: tempDir,
  generatedRoot
});
assert.deepEqual(
  opencodeIntegrationApply.results.map((result) => result.id),
  ['opencode', 'lloom-opencode']
);
assert(opencodeIntegrationApply.results[0].backupPath?.includes('opencode.json.bak-'));
assert.equal(JSON.parse(await fs.readFile(opencodeTargetPath, 'utf8')).provider['local-llm'].name, 'LLooM Local');
assert.equal((await fs.stat(path.join(tempDir, '.lloom', 'bin', 'lloom-opencode'))).mode & 0o111, 0o111);
const opencodeIntegrationStatusAfter = await createClientIntegrationStatus(config, registry, {
  clientId: 'opencode',
  home: tempDir,
  generatedRoot
});
assert.equal(opencodeIntegrationStatusAfter.ok, true);
assert.equal(opencodeIntegrationStatusAfter.summary.current, 2);
const codexIntegrationsCli = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'integrations',
      'codex',
      '--home',
      tempDir,
      '--generated-root',
      generatedRoot
    ])
  ).stdout
);
assert.equal(codexIntegrationsCli.ok, true);
assert.equal(codexIntegrationsCli.summary.current, 2);
assert(codexIntegrationsCli.data.every((artifact) => artifact.current));

const statusModelRoot = path.join(tempDir, 'status-models');
await fs.mkdir(path.join(statusModelRoot, 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed'), { recursive: true });
await fs.writeFile(
  path.join(statusModelRoot, 'Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed', 'model-00001-of-00001.safetensors'),
  'weights\n',
  'utf8'
);
const setupStatusStatePath = path.join(tempDir, 'setup-status-state.json');
const setupStatusGeneratedRoot = path.join(tempDir, 'setup-status-generated');
const setupRecipePlatformSupported = process.platform === 'darwin' && process.arch === 'arm64';
const setupStatusBeforeIntegration = await createSetupStatus(config, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: statusModelRoot,
  clientId: 'omp',
  home: tempDir,
  generatedRoot: setupStatusGeneratedRoot,
  statePath: setupStatusStatePath,
  includeRuntimes: false
});
assert.equal(setupStatusBeforeIntegration.ok, setupRecipePlatformSupported);
assert.equal(setupStatusBeforeIntegration.recipe.platformSupported, setupRecipePlatformSupported);
assert.equal(setupStatusBeforeIntegration.complete, false);
assert.equal(setupStatusBeforeIntegration.integrations.ready, false);
assert.equal(setupStatusBeforeIntegration.integrations.summary.missing, 2);
assert.equal(setupStatusBeforeIntegration.runtimes, null);
assert.equal(setupStatusBeforeIntegration.recipe.steps.find((step) => step.id === 'download-27b').status, 'satisfied');
assert.equal(
  setupStatusBeforeIntegration.recipe.models.find((model) => model.role === 'fastest-27b').destination.populated,
  true
);
assert.equal(
  setupStatusBeforeIntegration.recipe.models.find((model) => model.role === 'fastest-35b-a3b').destination.status,
  'missing'
);

const staleRootStatePath = path.join(tempDir, 'stale-root-state.json');
await fs.writeFile(
  staleRootStatePath,
  `${JSON.stringify(
    {
      version: 1,
      backends: {},
      recipes: {
        'apple-silicon-qwen36': {
          steps: {
            'download-35b-a3b': {
              status: 'completed',
              completedAt: '2026-07-07T00:00:00Z',
              reason: 'destination-populated',
              command: [
                'hf',
                'download',
                'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16',
                '--local-dir',
                '/stale/root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'
              ]
            },
            'tune-35b-a3b': {
              status: 'completed',
              completedAt: '2026-07-07T00:00:00Z',
              reason: 'skip-path-exists',
              command: [
                'mtplx',
                'tune',
                '--model',
                '/stale/root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16',
                '--retune'
              ]
            }
          }
        }
      }
    },
    null,
    2
  )}\n`,
  'utf8'
);
const staleRootModelRoot = path.join(tempDir, 'missing-model-root');
const staleRootStatus = await createSetupStatus(config, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: staleRootModelRoot,
  clientId: 'omp',
  home: tempDir,
  generatedRoot: setupStatusGeneratedRoot,
  statePath: staleRootStatePath,
  includeRuntimes: false
});
const staleDownloadStep = staleRootStatus.recipe.steps.find((step) => step.id === 'download-35b-a3b');
const staleTuneStep = staleRootStatus.recipe.steps.find((step) => step.id === 'tune-35b-a3b');
assert.equal(staleDownloadStep.status, 'pending');
assert.equal(staleDownloadStep.ready, false);
assert.equal(staleDownloadStep.reason, 'state-artifact-missing-for-current-root');
assert.equal(staleDownloadStep.destination.status, 'missing');
assert(
  staleDownloadStep.command.includes(
    path.join(staleRootModelRoot, 'Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16')
  )
);
assert(!staleDownloadStep.command.includes('/stale/root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));
assert.equal(staleTuneStep.status, 'pending');
assert.equal(staleTuneStep.ready, false);
assert.equal(staleTuneStep.reason, 'state-artifact-missing-for-current-root');
assert.equal(staleTuneStep.skipPath.status, 'missing');
assert(
  staleTuneStep.command.includes(path.join(staleRootModelRoot, 'Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'))
);
assert(!staleTuneStep.command.includes('/stale/root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));

const homeStateHome = path.join(tempDir, 'setup-status-home-state-home');
const homeStateModelRoot = path.join(tempDir, 'setup-status-home-state-models');
await fs.mkdir(path.join(homeStateHome, '.lloom'), { recursive: true });
await fs.writeFile(
  path.join(homeStateHome, '.lloom', 'install-state.json'),
  `${JSON.stringify(
    {
      version: 1,
      backends: {},
      recipes: {
        'apple-silicon-qwen36': {
          steps: {
            'download-35b-a3b': {
              status: 'completed',
              completedAt: '2026-07-07T00:00:00Z',
              reason: 'destination-populated',
              command: [
                'hf',
                'download',
                'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16',
                '--local-dir',
                '/home-state/stale-root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'
              ]
            }
          }
        }
      }
    },
    null,
    2
  )}\n`,
  'utf8'
);
const homeStateStatus = await createSetupStatus(config, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: homeStateModelRoot,
  clientId: 'omp',
  home: homeStateHome,
  generatedRoot: setupStatusGeneratedRoot,
  includeRuntimes: false
});
assert.equal(homeStateStatus.statePath, path.join(homeStateHome, '.lloom', 'install-state.json'));
const homeStateDownloadStep = homeStateStatus.recipe.steps.find((step) => step.id === 'download-35b-a3b');
assert.equal(homeStateDownloadStep.reason, 'state-artifact-missing-for-current-root');
assert(
  homeStateDownloadStep.command.includes(
    path.join(homeStateModelRoot, 'Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16')
  )
);
assert(
  !homeStateDownloadStep.command.includes(
    '/home-state/stale-root/Youssofal--Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'
  )
);

const staleBackendStatePath = path.join(tempDir, 'stale-backend-state.json');
await fs.writeFile(
  staleBackendStatePath,
  `${JSON.stringify(
    {
      version: 1,
      backends: {
        mtplx: {
          steps: {
            'link-mtplx': {
              status: 'completed',
              completedAt: '2026-07-07T00:00:00Z'
            }
          }
        }
      },
      recipes: {}
    },
    null,
    2
  )}\n`,
  'utf8'
);
const staleBackendStatus = await createSetupStatus(config, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: statusModelRoot,
  clientId: 'omp',
  home: tempDir,
  generatedRoot: setupStatusGeneratedRoot,
  statePath: staleBackendStatePath,
  includeRuntimes: false,
  backendVariables: {
    ...defaultBackendVariables(process.env),
    installRoot: path.join(tempDir, 'missing-backends'),
    backendRoot: path.join(tempDir, 'missing-backends'),
    shimDir: path.join(tempDir, 'missing-shims'),
    LLOOM_MTPLX_BIN: ''
  }
});
const staleBackendLinkStep = staleBackendStatus.backend.steps.find((step) => step.id === 'link-mtplx');
assert.equal(staleBackendLinkStep.status, 'pending');
assert.equal(staleBackendLinkStep.ready, false);
assert.equal(staleBackendLinkStep.reason, 'state-artifact-missing-for-current-backend');
assert.equal(staleBackendLinkStep.artifact.satisfied, false);

const setupStatusIntegrationConfig = deriveUserConfig(config, recipe, {
  modelRoot: statusModelRoot
});
const setupStatusIntegrationConfigPath = path.join(tempDir, 'setup-status-integration-config.json');
await fs.writeFile(
  setupStatusIntegrationConfigPath,
  `${JSON.stringify(setupStatusIntegrationConfig, null, 2)}\n`,
  'utf8'
);
const setupStatusIntegrationRegistry = createRegistry(setupStatusIntegrationConfig);
const integrationApply = await applyIntegrationArtifacts(setupStatusIntegrationConfig, setupStatusIntegrationRegistry, {
  clientId: 'omp',
  dryRun: false,
  yes: true,
  home: tempDir,
  generatedRoot
});
assert.equal(integrationApply.results[0].status, 'written');
assert.equal(integrationApply.results[1].status, 'written');
const tempOmp = await fs.readFile(path.join(tempDir, '.omp', 'agent', 'models.yml'), 'utf8');
assert(tempOmp.includes('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
assert(!tempOmp.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n'));
const tempOmpConfig = await fs.readFile(path.join(tempDir, '.omp', 'agent', 'config.yml'), 'utf8');
assert(tempOmpConfig.includes('default: local-llm/Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16:low'));
assert(!tempOmpConfig.includes('Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n'));

const setupStatusAfterIntegration = await createSetupStatus(setupStatusIntegrationConfig, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: statusModelRoot,
  clientId: 'omp',
  home: tempDir,
  generatedRoot: setupStatusGeneratedRoot,
  statePath: setupStatusStatePath,
  includeRuntimes: false
});
assert.equal(setupStatusAfterIntegration.integrations.ready, true);
assert.equal(setupStatusAfterIntegration.integrations.summary.current, 2);
assert(setupStatusAfterIntegration.integrations.data.every((integration) => integration.current));
assert.equal(setupStatusAfterIntegration.next.backendInstall, 'lloom backend-install mtplx --apply --yes');
assert(setupStatusAfterIntegration.next.setup.includes("--client 'omp'"));

const setupStatusCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'setup-status',
  '--config',
  setupStatusIntegrationConfigPath,
  '--recipe',
  'apple-silicon-qwen36',
  '--model-root',
  statusModelRoot,
  '--client',
  'omp',
  '--home',
  tempDir,
  '--state',
  setupStatusStatePath,
  '--generated-root',
  setupStatusGeneratedRoot,
  '--no-runtimes'
]);
const setupStatusCliJson = JSON.parse(setupStatusCli.stdout);
assert.equal(setupStatusCliJson.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(setupStatusCliJson.integrations.ready, true);
assert.equal(setupStatusCliJson.runtimes, null);
assert.equal(setupStatusCliJson.recipe.steps.find((step) => step.id === 'download-27b').status, 'satisfied');

const doctorReport = await createDoctorReport(setupStatusIntegrationConfig, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: statusModelRoot,
  clientId: 'omp',
  home: tempDir,
  generatedRoot: setupStatusGeneratedRoot,
  statePath: setupStatusStatePath,
  includeRuntimes: false
});
assert.equal(doctorReport.ok, setupRecipePlatformSupported);
assert.equal(doctorReport.complete, false);
assert.equal(doctorReport.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(doctorReport.phases.find((phase) => phase.id === 'clients').status, 'ready');
assert.equal(doctorReport.phases.find((phase) => phase.id === 'models').status, 'action-needed');
assert.equal(doctorReport.phases.find((phase) => phase.id === 'runtimes').status, 'skipped');
assert(doctorReport.actions.some((action) => action.id === 'install-recipe'));
assert(doctorReport.actions.some((action) => action.id === 'apply-all'));

const doctorCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'doctor',
  '--config',
  setupStatusIntegrationConfigPath,
  '--recipe',
  'apple-silicon-qwen36',
  '--model-root',
  statusModelRoot,
  '--client',
  'omp',
  '--home',
  tempDir,
  '--state',
  setupStatusStatePath,
  '--generated-root',
  setupStatusGeneratedRoot,
  '--no-runtimes'
]);
assert(doctorCli.stdout.includes('LLooM doctor'));
assert(doctorCli.stdout.includes('Model Registry: ready'));
assert(doctorCli.stdout.includes('Models: action-needed'));
const doctorCliJson = JSON.parse(
  (
    await runCommand(process.execPath, [
      path.join(process.cwd(), 'bin', 'lloom.mjs'),
      'doctor',
      '--config',
      setupStatusIntegrationConfigPath,
      '--recipe',
      'apple-silicon-qwen36',
      '--model-root',
      statusModelRoot,
      '--client',
      'omp',
      '--home',
      tempDir,
      '--state',
      setupStatusStatePath,
      '--generated-root',
      setupStatusGeneratedRoot,
      '--no-runtimes',
      '--json'
    ])
  ).stdout
);
assert.equal(doctorCliJson.ok, setupRecipePlatformSupported);
assert.equal(doctorCliJson.complete, false);
assert.equal(doctorCliJson.phases.find((phase) => phase.id === 'clients').status, 'ready');
assert.equal(doctorCliJson.phases.find((phase) => phase.id === 'models').status, 'action-needed');

const { LLOOM_CONFIG: _unusedLloomConfig, ...envWithoutLloomConfig } = process.env;
const freshDoctorHome = path.join(tempDir, 'fresh-doctor-home');
const missingDoctorCli = await runCommand(
  process.execPath,
  [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'doctor', '--home', freshDoctorHome, '--no-runtimes'],
  { env: envWithoutLloomConfig }
);
assert(missingDoctorCli.stdout.includes('LLooM is not installed yet'));
assert(missingDoctorCli.stdout.includes(`Config: ${path.join(freshDoctorHome, '.lloom', 'config.json')}`));
assert(missingDoctorCli.stdout.includes('Install, configure, integrate, and warm LLooM: lloom up'));
assert(missingDoctorCli.stdout.includes('--go'));

const missingDoctorCliJson = JSON.parse(
  (
    await runCommand(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'doctor', '--home', freshDoctorHome, '--no-runtimes', '--json'],
      { env: envWithoutLloomConfig }
    )
  ).stdout
);
assert.equal(missingDoctorCliJson.status, 'not-installed');
assert.equal(missingDoctorCliJson.ok, false);
assert.equal(missingDoctorCliJson.config, path.join(freshDoctorHome, '.lloom', 'config.json'));
assert.equal(missingDoctorCliJson.phases[0].id, 'install');
assert(missingDoctorCliJson.next.plan.includes(`--home '${freshDoctorHome}'`));
assert(missingDoctorCliJson.next.applyAndStart.includes('--go'));

for (const command of ['models', 'integrate', 'runtimes']) {
  const freshCommandHome = path.join(tempDir, `fresh-${command}-home`);
  const args = [
    path.join(process.cwd(), 'bin', 'lloom.mjs'),
    command,
    ...(command === 'integrate' ? ['all'] : []),
    '--home',
    freshCommandHome
  ];
  const freshCommandCli = await runCommand(process.execPath, args, { env: envWithoutLloomConfig });
  assert(freshCommandCli.stdout.includes('LLooM is not installed yet'));
  assert(freshCommandCli.stdout.includes('Details: rerun with --json'));
  const freshCommandJson = JSON.parse(
    (await runCommand(process.execPath, [...args, '--json'], { env: envWithoutLloomConfig })).stdout
  );
  assert.equal(freshCommandJson.status, 'not-installed');
  assert.equal(freshCommandJson.config, path.join(freshCommandHome, '.lloom', 'config.json'));
  assert.equal(freshCommandJson.phases[0].id, 'install');
  assert(freshCommandJson.next.applyAndStart.includes('--go'));
}

const installedCliHome = path.join(tempDir, 'installed-cli-home');
const installedCliConfigPath = path.join(installedCliHome, '.lloom', 'config.json');
await fs.mkdir(path.dirname(installedCliConfigPath), { recursive: true });
await fs.writeFile(installedCliConfigPath, `${JSON.stringify(setupStatusIntegrationConfig, null, 2)}\n`, 'utf8');
const installedDoctorCli = await runCommand(
  process.execPath,
  [
    path.join(process.cwd(), 'bin', 'lloom.mjs'),
    'doctor',
    '--home',
    installedCliHome,
    '--recipe',
    'apple-silicon-qwen36',
    '--model-root',
    statusModelRoot,
    '--client',
    'omp',
    '--state',
    setupStatusStatePath,
    '--generated-root',
    setupStatusGeneratedRoot,
    '--no-runtimes'
  ],
  { env: envWithoutLloomConfig }
);
assert(installedDoctorCli.stdout.includes('LLooM doctor'));
assert(installedDoctorCli.stdout.includes(`Config: ${installedCliConfigPath}`));
const installedDoctorCliJson = JSON.parse(
  (
    await runCommand(
      process.execPath,
      [
        path.join(process.cwd(), 'bin', 'lloom.mjs'),
        'doctor',
        '--home',
        installedCliHome,
        '--recipe',
        'apple-silicon-qwen36',
        '--model-root',
        statusModelRoot,
        '--client',
        'omp',
        '--state',
        setupStatusStatePath,
        '--generated-root',
        setupStatusGeneratedRoot,
        '--no-runtimes',
        '--json'
      ],
      { env: envWithoutLloomConfig }
    )
  ).stdout
);
assert.equal(installedDoctorCliJson.config, installedCliConfigPath);
assert.equal(installedDoctorCliJson.phases.find((phase) => phase.id === 'registry').status, 'ready');
const installedModelsCli = await runCommand(
  process.execPath,
  [path.join(process.cwd(), 'bin', 'lloom.mjs'), 'models', '--home', installedCliHome],
  { env: envWithoutLloomConfig }
);
const installedModelsCliJson = JSON.parse(installedModelsCli.stdout);
assert(
  installedModelsCliJson.data.some((model) => model.id === 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16')
);

const bootstrapPlan = await createBootstrapPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  backendVariables: {
    shimDir: path.join(tempDir, 'bootstrap-bin'),
    backendRoot: path.join(tempDir, 'backends'),
    installRoot: path.join(tempDir, 'install'),
    repoParent: path.dirname(process.cwd()),
    modelRoot: '/models'
  }
});
assert.equal(bootstrapPlan.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(bootstrapPlan.backend.id, 'mtplx');
assert.equal(bootstrapPlan.recipe.validationErrors.length, 0);
assert.equal(bootstrapPlan.benchmarks.validationErrors.length, 0);
assert.equal(
  bootstrapPlan.recipe.models.find((model) => model.role === 'fastest-27b')?.benchmark.best.id,
  'qwen36-27b-mtplx-speed-m2max-d3'
);
assert.deepEqual(
  bootstrapPlan.integrations.map((integration) => integration.id),
  ['omp-models', 'omp-config']
);
assert(bootstrapPlan.next.pathHint.includes('bootstrap-bin'));

const bootstrapBackendCatalogPath = path.join(tempDir, 'bootstrap-backend-catalog.json');
await fs.writeFile(
  bootstrapBackendCatalogPath,
  `${JSON.stringify(
    {
      ...backendCatalog,
      id: 'bootstrap-test-catalog',
      backends: backendCatalog.backends.map((backend) =>
        backend.id === 'mtplx' ? { ...backend, platforms: [`${process.platform}-${process.arch}`] } : backend
      )
    },
    null,
    2
  )}\n`,
  'utf8'
);
const bootstrapDryRun = await applyBootstrap(config, {
  recipeId: 'apple-silicon-qwen36',
  backendCatalogPath: bootstrapBackendCatalogPath,
  modelRoot: '/models',
  clientId: 'omp',
  dryRun: true,
  statePath: path.join(tempDir, 'bootstrap-state.json'),
  home: tempDir,
  backendVariables: {
    shimDir: path.join(tempDir, 'bootstrap-bin'),
    backendRoot: path.join(tempDir, 'backends'),
    installRoot: path.join(tempDir, 'install'),
    repoParent: path.dirname(process.cwd()),
    modelRoot: '/models'
  }
});
assert.equal(bootstrapDryRun.dryRun, true);
assert.equal(bootstrapDryRun.status, 'planned');
assert(bootstrapDryRun.backend.results.every((result) => result.status === 'planned'));
assert(bootstrapDryRun.recipe.results.every((result) => result.status === 'planned'));
assert(bootstrapDryRun.integrations.results.every((result) => result.status === 'planned'));
await assert.rejects(
  () =>
    applyBootstrap(config, {
      recipeId: 'apple-silicon-qwen36',
      modelRoot: '/models',
      clientId: 'omp',
      dryRun: false,
      statePath: path.join(tempDir, 'bootstrap-refuse-state.json'),
      home: tempDir
    }),
  /Refusing to bootstrap/
);

const failingBackendCatalogPath = path.join(tempDir, 'failing-backend-catalog.json');
await fs.writeFile(
  failingBackendCatalogPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: 'failing-test-catalog',
      name: 'Failing Test Catalog',
      backends: [
        {
          id: 'failing-test',
          name: 'Failing Test Backend',
          kind: 'openai-compatible-server',
          platforms: [`${process.platform}-${process.arch}`],
          setup: [
            {
              id: 'fail-backend',
              action: 'command',
              command: '/usr/bin/false'
            }
          ]
        }
      ]
    },
    null,
    2
  )}\n`,
  'utf8'
);
const failingRecipe = {
  schemaVersion: 1,
  id: 'failing-bootstrap-recipe',
  name: 'Failing Bootstrap Recipe',
  backend: {
    id: 'failing-test'
  },
  models: [
    {
      role: 'default',
      model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
      runtime: 'mtplx-qwen36-27b-speed'
    }
  ],
  setup: {
    steps: [
      {
        id: 'should-not-run',
        action: 'command',
        command: '/usr/bin/true'
      }
    ]
  }
};
const failingBootstrapStatePath = path.join(tempDir, 'failing-bootstrap-state.json');
const failingBootstrap = await applyBootstrap(config, {
  recipeId: 'failing-bootstrap-recipe',
  recipeDocuments: [failingRecipe],
  recipesRoot: path.join(tempDir, 'missing-failing-recipes'),
  backendCatalogPath: failingBackendCatalogPath,
  modelRoot: '/models',
  clientId: 'omp',
  dryRun: false,
  yes: true,
  statePath: failingBootstrapStatePath,
  home: tempDir
});
assert.equal(failingBootstrap.ok, false);
assert.equal(failingBootstrap.status, 'failed');
assert.equal(failingBootstrap.backend.summary.status, 'failed');
assert.equal(failingBootstrap.recipe.blocked, true);
assert.equal(failingBootstrap.recipe.reason, 'backend phase failed');
assert.equal(failingBootstrap.integrations.blocked, true);
assert.equal(failingBootstrap.integrations.reason, 'recipe phase failed');
const failingBootstrapState = await readInstallState(failingBootstrapStatePath);
assert.equal(failingBootstrapState.backends['failing-test'].steps['fail-backend'].status, 'failed');
assert.equal(failingBootstrapState.recipes['failing-bootstrap-recipe'], undefined);

const setupBackendVariables = {
  shimDir: path.join(tempDir, 'setup-bin'),
  backendRoot: path.join(tempDir, 'setup-backends'),
  installRoot: path.join(tempDir, 'setup-install'),
  repoParent: path.dirname(process.cwd()),
  modelRoot: '/models'
};
const failingSetup = await applySetup(config, {
  recipeId: 'failing-bootstrap-recipe',
  recipeDocuments: [failingRecipe],
  recipesRoot: path.join(tempDir, 'missing-failing-setup-recipes'),
  backendCatalogPath: failingBackendCatalogPath,
  configPath: path.join(tempDir, 'failing-setup-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  dryRun: false,
  yes: true,
  statePath: path.join(tempDir, 'failing-setup-state.json'),
  home: tempDir,
  generatedRoot: path.join(tempDir, 'failing-setup-generated'),
  backendVariables: setupBackendVariables
});
assert.equal(failingSetup.ok, false);
assert.equal(failingSetup.status, 'failed');
assert.equal(failingSetup.phases.bootstrap.recipe.blocked, true);
assert.equal(failingSetup.phases.bootstrap.integrations.blocked, true);
const setupPlan = await createSetupPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'setup-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'setup-generated'),
  backendVariables: setupBackendVariables
});
assert.equal(setupPlan.dryRun, true);
assert.equal(setupPlan.configPath, path.join(tempDir, 'setup-config.json'));
assert.equal(setupPlan.selectedRecipe.id, 'apple-silicon-qwen36');
assert.deepEqual(setupPlan.keepWarm, ['mtplx-qwen36-35b-a3b-speed-fp16']);
assert.equal(setupPlan.phases.init.config.runtimes['mtplx-qwen36-27b-speed'].enabled, true);
assert.equal(setupPlan.phases.bootstrap.recipe.validationErrors.length, 0);
assert(
  setupPlan.phases.bootstrap.integrations.every((integration) =>
    integration.generatedPath.startsWith(path.join(tempDir, 'setup-generated'))
  )
);
assert(setupPlan.next.apply.includes('lloom setup'));
assert(setupPlan.next.apply.includes(`--home '${tempDir}'`));
assert(setupPlan.next.apply.includes(`--generated-root '${path.join(tempDir, 'setup-generated')}'`));
assert(setupPlan.next.applyAndStart.includes('--start'));

const onboardingPlan = await createOnboardingPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'onboard-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'onboard-generated'),
  backendVariables: setupBackendVariables,
  includeRuntimes: false
});
assert.equal(onboardingPlan.schemaVersion, 1);
assert.equal(onboardingPlan.dryRun, true);
assert.equal(onboardingPlan.objective, 'install-from-zero');
assert.equal(onboardingPlan.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(onboardingPlan.configPath, path.join(tempDir, 'onboard-config.json'));
assert.equal(onboardingPlan.stages[0].id, 'inspect');
assert.equal(onboardingPlan.stages.find((stage) => stage.id === 'configure').status, 'planned');
assert.equal(onboardingPlan.stages.find((stage) => stage.id === 'runtimes').status, 'skipped');
assert(onboardingPlan.next.apply.includes('lloom onboard'));
assert(onboardingPlan.next.apply.includes(`--home '${tempDir}'`));
assert(onboardingPlan.next.apply.includes(`--generated-root '${path.join(tempDir, 'onboard-generated')}'`));
assert(onboardingPlan.next.applyAndStart.includes('--start'));
assert(onboardingPlan.next.doctor.includes('lloom doctor'));
assert(onboardingPlan.next.doctor.includes(`--home '${tempDir}'`));
assert(onboardingPlan.next.doctor.includes(`--generated-root '${path.join(tempDir, 'onboard-generated')}'`));
assert.equal(onboardingPlan.next.dashboard, 'http://127.0.0.1:8100/');
assert.equal(onboardingPlan.setup.phases.bootstrap.recipe.validationErrors.length, 0);
assert.equal(onboardingPlan.doctor.selectedRecipe.id, 'apple-silicon-qwen36');
const onboardingRuntimePreview = await createOnboardingPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'onboard-runtime-preview-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'onboard-runtime-preview-generated'),
  backendVariables: setupBackendVariables,
  includeRuntimes: true
});
assert.equal(onboardingRuntimePreview.stages.find((stage) => stage.id === 'runtimes').status, 'skipped');
assert(
  onboardingRuntimePreview.stages.find((stage) => stage.id === 'runtimes').summary.includes('waits until setup applies')
);
const onboardingStartPreview = await createOnboardingPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'onboard-start-preview-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'onboard-start-preview-generated'),
  backendVariables: setupBackendVariables,
  includeRuntimes: true,
  start: true
});
assert.equal(onboardingStartPreview.stages.find((stage) => stage.id === 'runtimes').status, 'planned');
assert(
  onboardingStartPreview.stages
    .find((stage) => stage.id === 'runtimes')
    .summary.includes('will start after setup applies')
);
const onboardingDryRun = await applyOnboarding(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'onboard-dry-run-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'onboard-dry-run-generated'),
  backendVariables: setupBackendVariables,
  includeRuntimes: false
});
assert.equal(onboardingDryRun.dryRun, true);
assert.equal(onboardingDryRun.selectedRecipe.id, 'apple-silicon-qwen36');
await assert.rejects(
  () =>
    applyOnboarding(config, {
      recipeId: 'apple-silicon-qwen36',
      configPath: path.join(tempDir, 'onboard-refuse-config.json'),
      modelRoot: '/models',
      clientId: 'omp',
      dryRun: false,
      home: tempDir,
      backendVariables: setupBackendVariables
    }),
  /Refusing to onboard/
);

const setupPortPlan = await createSetupPlan(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'setup-ports-config.json'),
  modelRoot: '/models',
  gatewayPort: 9101,
  backendPortRange: '9300-9399',
  clientId: 'omp',
  home: tempDir,
  generatedRoot: path.join(tempDir, 'setup-ports-generated'),
  backendVariables: setupBackendVariables
});
assert.equal(setupPortPlan.phases.init.config.server.port, 9101);
assert.equal(setupPortPlan.phases.init.config.runtimes['mtplx-qwen36-27b-speed'].port, 9300);
assert(setupPortPlan.next.apply.includes("--port '9101'"));
assert(setupPortPlan.next.apply.includes("--backend-port-range '9300-9399'"));

const setupDryRun = await applySetup(config, {
  recipeId: 'apple-silicon-qwen36',
  configPath: path.join(tempDir, 'setup-apply-config.json'),
  modelRoot: '/models',
  clientId: 'omp',
  dryRun: true,
  home: tempDir,
  generatedRoot: path.join(tempDir, 'setup-apply-generated'),
  backendVariables: setupBackendVariables
});
assert.equal(setupDryRun.dryRun, true);
assert.equal(setupDryRun.phases.bootstrap.backend.id, 'mtplx');
assert(
  setupDryRun.phases.bootstrap.integrations.every((integration) =>
    integration.generatedPath.startsWith(path.join(tempDir, 'setup-apply-generated'))
  )
);

await assert.rejects(
  () =>
    applySetup(config, {
      recipeId: 'apple-silicon-qwen36',
      configPath: path.join(tempDir, 'setup-refuse-config.json'),
      modelRoot: '/models',
      clientId: 'omp',
      dryRun: false,
      home: tempDir,
      backendVariables: setupBackendVariables
    }),
  /Refusing to run setup/
);

const setupCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'setup',
  '--recipe',
  'apple-silicon-qwen36',
  '--config-out',
  path.join(tempDir, 'setup-cli-config.json'),
  '--model-root',
  '/models',
  '--client',
  'omp'
]);
const setupCliJson = JSON.parse(setupCli.stdout);
assert.equal(setupCliJson.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(setupCliJson.phases.init.configPath, path.join(tempDir, 'setup-cli-config.json'));
assert.equal(setupCliJson.phases.bootstrap.recipe.validationErrors.length, 0);

const onboardCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'onboard',
  '--json',
  '--recipe',
  'apple-silicon-qwen36',
  '--config-out',
  path.join(tempDir, 'onboard-cli-config.json'),
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--no-runtimes'
]);
const onboardCliJson = JSON.parse(onboardCli.stdout);
assert.equal(onboardCliJson.dryRun, true);
assert.equal(onboardCliJson.objective, 'install-from-zero');
assert.equal(onboardCliJson.configPath, path.join(tempDir, 'onboard-cli-config.json'));
assert.equal(onboardCliJson.stages.find((stage) => stage.id === 'runtimes').status, 'skipped');
assert(onboardCliJson.next.apply.includes('lloom onboard'));

const upCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'up',
  '--json',
  '--recipe',
  'apple-silicon-qwen36',
  '--config-out',
  path.join(tempDir, 'up-cli-config.json'),
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--no-runtimes'
]);
const upCliJson = JSON.parse(upCli.stdout);
assert.equal(upCliJson.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(upCliJson.configPath, path.join(tempDir, 'up-cli-config.json'));

const upHome = path.join(tempDir, 'up-cli-home-default-config');
const upHomeDefaultConfigCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'up',
  '--json',
  '--recipe',
  'apple-silicon-qwen36',
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--home',
  upHome,
  '--no-runtimes'
]);
const upHomeDefaultConfigJson = JSON.parse(upHomeDefaultConfigCli.stdout);
assert.equal(upHomeDefaultConfigJson.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(upHomeDefaultConfigJson.configPath, path.join(upHome, '.lloom', 'config.json'));
assert(upHomeDefaultConfigJson.next.apply.includes(path.join(upHome, '.lloom', 'config.json')));
assert(upHomeDefaultConfigJson.next.apply.includes(`--home '${upHome}'`));

const setupHome = path.join(tempDir, 'setup-cli-home-default-config');
const setupHomeDefaultConfigCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'setup',
  '--recipe',
  'apple-silicon-qwen36',
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--home',
  setupHome
]);
const setupHomeDefaultConfigJson = JSON.parse(setupHomeDefaultConfigCli.stdout);
assert.equal(setupHomeDefaultConfigJson.phases.init.configPath, path.join(setupHome, '.lloom', 'config.json'));
assert(setupHomeDefaultConfigJson.next.apply.includes(`--home '${setupHome}'`));

const defaultCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  '--json',
  '--recipe',
  'apple-silicon-qwen36',
  '--config-out',
  path.join(tempDir, 'default-cli-config.json'),
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--home',
  tempDir,
  '--generated-root',
  path.join(tempDir, 'default-cli-generated'),
  '--no-runtimes'
]);
const defaultCliJson = JSON.parse(defaultCli.stdout);
assert.equal(defaultCliJson.dryRun, true);
assert.equal(defaultCliJson.objective, 'install-from-zero');
assert.equal(defaultCliJson.selectedRecipe.id, 'apple-silicon-qwen36');
assert.equal(defaultCliJson.configPath, path.join(tempDir, 'default-cli-config.json'));
assert.equal(defaultCliJson.stages.find((stage) => stage.id === 'runtimes').status, 'skipped');
assert(defaultCliJson.next.apply.includes(`--home '${tempDir}'`));
assert(defaultCliJson.next.apply.includes(`--generated-root '${path.join(tempDir, 'default-cli-generated')}'`));
assert(defaultCliJson.next.applyAndStart.includes('--start'));

const humanOnboardCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'onboard',
  '--recipe',
  'apple-silicon-qwen36',
  '--config-out',
  path.join(tempDir, 'human-onboard-cli-config.json'),
  '--model-root',
  '/models',
  '--client',
  'omp',
  '--no-runtimes'
]);
assert(humanOnboardCli.stdout.includes('LLooM found a recommended local model'));
assert(humanOnboardCli.stdout.includes('Recommended model:'));
assert(humanOnboardCli.stdout.includes('What is missing:'));
assert(humanOnboardCli.stdout.includes('Model files: missing in /models.'));
assert(humanOnboardCli.stdout.includes('Client configs:'));
assert(humanOnboardCli.stdout.includes('Details: rerun with --json'));
assert(!humanOnboardCli.stdout.trimStart().startsWith('{'));

const noopBackendCatalogPath = path.join(tempDir, 'noop-backend-catalog.json');
await fs.writeFile(
  noopBackendCatalogPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: 'noop-backend-catalog',
      name: 'No-op backend catalog',
      backends: [
        {
          id: 'synthetic-noop',
          name: 'Synthetic No-op',
          kind: 'openai-compatible-server',
          platforms: [`${process.platform}-${process.arch}`],
          commands: [],
          setup: [],
          server: {
            protocol: 'openai',
            healthPath: '/health',
            chatPath: '/v1/chat/completions'
          }
        }
      ]
    },
    null,
    2
  )}\n`,
  'utf8'
);
const noopRecipeRoot = path.join(tempDir, 'noop-recipes');
await fs.mkdir(noopRecipeRoot, { recursive: true });
await fs.writeFile(
  path.join(noopRecipeRoot, 'synthetic-noop-onboard.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: 'synthetic-noop-onboard',
      name: 'Synthetic No-op Onboard',
      requirements: {
        platforms: [`${process.platform}-${process.arch}`]
      },
      backend: {
        id: 'synthetic-noop'
      },
      setup: {
        steps: []
      },
      models: [
        {
          role: 'default',
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          runtime: 'mtplx-qwen36-27b-speed'
        }
      ]
    },
    null,
    2
  )}\n`,
  'utf8'
);
const applyHumanCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'onboard',
  '--apply',
  '--yes',
  '--recipe',
  'synthetic-noop-onboard',
  '--recipes-root',
  noopRecipeRoot,
  '--backend-catalog',
  noopBackendCatalogPath,
  '--config-out',
  path.join(tempDir, 'noop-apply-config.json'),
  '--model-root',
  path.join(tempDir, 'noop-models'),
  '--home',
  path.join(tempDir, 'noop-home'),
  '--generated-root',
  path.join(tempDir, 'noop-generated'),
  '--state',
  path.join(tempDir, 'noop-state.json'),
  '--shim-dir',
  path.join(tempDir, 'noop-bin'),
  '--backend-root',
  path.join(tempDir, 'noop-backends'),
  '--install-root',
  path.join(tempDir, 'noop-install'),
  '--client',
  'omp',
  '--no-runtimes'
]);
assert(
  applyHumanCli.stdout.includes('LLooM is ready') ||
    applyHumanCli.stdout.includes('LLooM found a recommended local model')
);
assert(applyHumanCli.stdout.includes('Config file:'));
assert(applyHumanCli.stdout.includes('What is missing:'));
assert(applyHumanCli.stdout.includes('Model files: missing'));
assert(applyHumanCli.stdout.includes('Next:'));
assert(applyHumanCli.stdout.includes('Details: rerun with --json'));
assert(!applyHumanCli.stdout.trimStart().startsWith('{'));
assert.equal(
  JSON.parse(await fs.readFile(path.join(tempDir, 'noop-apply-config.json'), 'utf8')).init.recipeId,
  'synthetic-noop-onboard'
);
const applyJsonCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'onboard',
  '--apply',
  '--yes',
  '--json',
  '--recipe',
  'synthetic-noop-onboard',
  '--recipes-root',
  noopRecipeRoot,
  '--backend-catalog',
  noopBackendCatalogPath,
  '--config-out',
  path.join(tempDir, 'noop-apply-json-config.json'),
  '--model-root',
  path.join(tempDir, 'noop-json-models'),
  '--home',
  path.join(tempDir, 'noop-json-home'),
  '--generated-root',
  path.join(tempDir, 'noop-json-generated'),
  '--state',
  path.join(tempDir, 'noop-json-state.json'),
  '--shim-dir',
  path.join(tempDir, 'noop-json-bin'),
  '--backend-root',
  path.join(tempDir, 'noop-json-backends'),
  '--install-root',
  path.join(tempDir, 'noop-json-install'),
  '--client',
  'omp',
  '--no-runtimes'
]);
const applyJsonCliJson = JSON.parse(applyJsonCli.stdout);
assert.equal(applyJsonCliJson.dryRun, false);
assert.equal(applyJsonCliJson.status, 'applied');
assert.equal(applyJsonCliJson.selectedRecipe.id, 'synthetic-noop-onboard');
assert.equal(applyJsonCliJson.setup.phases.bootstrap.status, 'completed');

const homeDefaultApplyHome = path.join(tempDir, 'noop-home-default-apply-home');
const homeDefaultApplyCli = await runCommand(process.execPath, [
  path.join(process.cwd(), 'bin', 'lloom.mjs'),
  'onboard',
  '--apply',
  '--yes',
  '--json',
  '--recipe',
  'synthetic-noop-onboard',
  '--recipes-root',
  noopRecipeRoot,
  '--backend-catalog',
  noopBackendCatalogPath,
  '--model-root',
  path.join(tempDir, 'noop-home-default-models'),
  '--home',
  homeDefaultApplyHome,
  '--state',
  path.join(tempDir, 'noop-home-default-state.json'),
  '--shim-dir',
  path.join(tempDir, 'noop-home-default-bin'),
  '--backend-root',
  path.join(tempDir, 'noop-home-default-backends'),
  '--install-root',
  path.join(tempDir, 'noop-home-default-install'),
  '--client',
  'omp',
  '--no-runtimes'
]);
const homeDefaultApplyJson = JSON.parse(homeDefaultApplyCli.stdout);
const homeDefaultConfigPath = path.join(homeDefaultApplyHome, '.lloom', 'config.json');
assert.equal(homeDefaultApplyJson.configPath, homeDefaultConfigPath);
assert.equal(JSON.parse(await fs.readFile(homeDefaultConfigPath, 'utf8')).init.recipeId, 'synthetic-noop-onboard');
assert.equal(homeDefaultApplyJson.setup.phases.init.configPath, homeDefaultConfigPath);

const testConfig = structuredClone(config);
testConfig.server = {
  host: '127.0.0.1',
  port: 0
};
testConfig.runtimes['mtplx-qwen36-27b-speed'].enabled = true;
testConfig.runtimes['mtplx-qwen36-35b-a3b-speed-fp16'].enabled = true;
const app = createLloomServer(testConfig, {
  logger: {
    error() {}
  }
});
const listened = await tryListen(app.server);

if (listened) {
  const { port } = app.server.address();
  try {
    const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const modelsJson = await modelsResponse.json();
    assert(modelsJson.data.some((model) => model.id === 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'));
    assert(modelsJson.data.some((model) => model.id === 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16'));
    assert(!modelsJson.data.some((model) => model.id === 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed'));
    assert(!modelsJson.data.some((model) => model.id === 'qwen36-27b-fastest'));
    assert(!modelsJson.data.some((model) => model.id === 'qwen36-35b-fastest'));

    const profileResponse = await fetch(`http://127.0.0.1:${port}/gateway/profile`);
    assert.equal(profileResponse.status, 200);
    assert(profileResponse.headers.get('content-type').includes(MACHINE_PROFILE_MEDIA_TYPE));
    const profileJson = await profileResponse.json();
    assert.deepEqual(validateMachineProfile(profileJson), []);
    assert.equal(profileJson.platformId, `${process.platform}-${process.arch}`);

    const integrationsResponse = await fetch(`http://127.0.0.1:${port}/gateway/integrations`);
    assert.equal(integrationsResponse.status, 200);
    assert(integrationsResponse.headers.get('content-type').includes(CLIENT_INTEGRATIONS_MEDIA_TYPE));
    const integrationsJson = await integrationsResponse.json();
    assert.equal(integrationsJson.schemaVersion, 1);
    assert.deepEqual(validateClientIntegrationManifest(integrationsJson), []);
    assert.equal(integrationsJson.provider.defaultModel, 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16');
    assert(integrationsJson.clients.some((client) => client.id === 'opencode'));

    const integrationsStatusParams = new URLSearchParams({
      client: 'codex',
      home: tempDir,
      generated_root: generatedRoot
    });
    const integrationsStatusResponse = await fetch(
      `http://127.0.0.1:${port}/gateway/integrations/status?${integrationsStatusParams}`
    );
    assert.equal(integrationsStatusResponse.status, 200);
    const integrationsStatusJson = await integrationsStatusResponse.json();
    assert.equal(integrationsStatusJson.ok, true);
    assert.equal(integrationsStatusJson.clientId, 'codex');
    assert.equal(integrationsStatusJson.summary.current, 2);
    assert(integrationsStatusJson.data.every((artifact) => artifact.current));

    const v1IntegrationsResponse = await fetch(`http://127.0.0.1:${port}/v1/integrations`);
    assert.equal(v1IntegrationsResponse.status, 200);
    const v1IntegrationsJson = await v1IntegrationsResponse.json();
    assert.equal(v1IntegrationsJson.$schema, 'https://lloom.dev/schemas/client-integrations.v1.schema.json');

    const runtimePlanResponse = await fetch(
      `http://127.0.0.1:${port}/gateway/runtimes/plan?runtime=mtplx-qwen36-27b-speed`
    );
    assert.equal(runtimePlanResponse.status, 200);
    const runtimePlanJson = await runtimePlanResponse.json();
    assert.equal(runtimePlanJson.requestedRuntimeId, 'mtplx-qwen36-27b-speed');
    const requestedRuntime = runtimePlanJson.runtimes?.find(
      (runtime) => runtime.runtimeId === 'mtplx-qwen36-27b-speed'
    );
    assert(requestedRuntime);
    // Already-loaded/external runtimes need no start action; idle ones should plan a start.
    if (requestedRuntime.loaded) {
      assert(!runtimePlanJson.actions.some((action) => action.type === 'start'));
    } else {
      assert(
        runtimePlanJson.actions.some(
          (action) => action.type === 'start' && action.runtimeId === 'mtplx-qwen36-27b-speed'
        )
      );
    }

    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(dashboardResponse.status, 200);
    assert(dashboardResponse.headers.get('content-type').includes('text/html'));
    const dashboardHtml = await dashboardResponse.text();
    assert(dashboardHtml.includes('<title>LLooM</title>'));
    const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert(dashboardScript);
    assert.doesNotThrow(() => new Function(dashboardScript));
    assert(dashboardHtml.includes('/gateway/library'));
    assert(dashboardHtml.includes('/gateway/onboarding/plan'));
    assert(dashboardHtml.includes('/gateway/setup/plan'));
    assert(dashboardHtml.includes('/gateway/backends'));
    assert(dashboardHtml.includes('/gateway/models/import-plan'));
    assert(dashboardHtml.includes('/gateway/community/recommendations'));
    assert(dashboardHtml.includes('/gateway/community/import'));
    assert(dashboardHtml.includes('/gateway/recipe-packs/plan'));
    assert(dashboardHtml.includes('/gateway/recipe-packs/import'));
    assert(!dashboardHtml.toLowerCase().includes('switchyard'));

    const dashboardAliasResponse = await fetch(`http://127.0.0.1:${port}/gateway/dashboard`);
    assert.equal(dashboardAliasResponse.status, 200);
    assert((await dashboardAliasResponse.text()).includes('Gateway summary'));

    const staleResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(staleResponse.status, 404);

    const setupStatusParams = new URLSearchParams({
      recipe: 'apple-silicon-qwen36',
      model_root: statusModelRoot,
      client: 'omp',
      home: tempDir,
      state: setupStatusStatePath,
      generated_root: setupStatusGeneratedRoot,
      runtimes: 'false'
    });
    const setupStatusResponse = await fetch(`http://127.0.0.1:${port}/gateway/setup/status?${setupStatusParams}`);
    assert.equal(setupStatusResponse.status, 200);
    const setupStatusJson = await setupStatusResponse.json();
    assert.equal(setupStatusJson.selectedRecipe.id, 'apple-silicon-qwen36');
    assert.equal(setupStatusJson.integrations.ready, true);
    assert.equal(setupStatusJson.runtimes, null);
    assert.equal(setupStatusJson.recipe.steps.find((step) => step.id === 'download-27b').status, 'satisfied');

    const doctorResponse = await fetch(`http://127.0.0.1:${port}/gateway/doctor?${setupStatusParams}`);
    assert.equal(doctorResponse.status, 200);
    const doctorJson = await doctorResponse.json();
    assert.equal(doctorJson.ok, setupRecipePlatformSupported);
    assert.equal(doctorJson.complete, false);
    assert.equal(doctorJson.selectedRecipe.id, 'apple-silicon-qwen36');
    assert.equal(doctorJson.phases.find((phase) => phase.id === 'clients').status, 'ready');
    assert.equal(doctorJson.phases.find((phase) => phase.id === 'models').status, 'action-needed');

    const onboardingPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/onboarding/plan?${setupStatusParams}`);
    assert.equal(onboardingPlanResponse.status, 200);
    const onboardingPlanJson = await onboardingPlanResponse.json();
    assert.equal(onboardingPlanJson.dryRun, true);
    assert.equal(onboardingPlanJson.objective, 'install-from-zero');
    assert.equal(onboardingPlanJson.selectedRecipe.id, 'apple-silicon-qwen36');
    assert(onboardingPlanJson.stages.some((stage) => stage.id === 'verify'));

    const onboardingRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/onboarding/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        recipe: 'apple-silicon-qwen36',
        model_root: statusModelRoot,
        client: 'omp',
        home: tempDir
      })
    });
    assert.equal(onboardingRefusedResponse.status, 400);
    assert((await onboardingRefusedResponse.text()).includes('Refusing to onboard'));

    const hostSubmissionsRoot = path.join(tempDir, 'real-host-benchmark-submissions');
    const realHost = createLloomHostServer(config, {
      port: 0,
      submissionsRoot: hostSubmissionsRoot
    });
    const realHostListened = await tryListen(realHost.server);
    if (realHostListened) {
      const realHostUrl = `http://127.0.0.1:${realHost.server.address().port}`;
      try {
        const hostHealthResponse = await fetch(`${realHostUrl}/health`);
        assert.equal(hostHealthResponse.status, 200);
        const hostHealthJson = await hostHealthResponse.json();
        assert.equal(hostHealthJson.service, 'lloom-host');
        assert(hostHealthJson.data.recipeCount >= 2);
        assert(hostHealthJson.data.benchmarkCount >= 2);

        const hostInterchangeResponse = await fetch(`${realHostUrl}/v1/interchange`);
        assert.equal(hostInterchangeResponse.status, 200);
        assert(hostInterchangeResponse.headers.get('content-type').includes(INTERCHANGE_REGISTRY_MEDIA_TYPE));
        const hostInterchangeJson = await hostInterchangeResponse.json();
        const hostInterchangeValidation = await validateInterchangeDocument(hostInterchangeJson, config);
        assert.equal(hostInterchangeValidation.ok, true);
        assert.equal(hostInterchangeValidation.kind, 'interchangeRegistry');
        assert(hostInterchangeJson.endpoints.some((endpoint) => endpoint.path === '/v1/benchmarks'));
        assert(
          hostInterchangeJson.endpoints.some(
            (endpoint) => endpoint.path === '/v1/keys' && endpoint.responseKind === 'signingKeys'
          )
        );
        assert(
          hostInterchangeJson.endpoints.some(
            (endpoint) => endpoint.path === '/v1/backends/catalog' && endpoint.responseKind === 'backendCatalog'
          )
        );
        assert(
          hostInterchangeJson.endpoints.every((endpoint) => endpoint.errorMediaType === ERROR_RESPONSE_MEDIA_TYPE)
        );

        const hostBackendsResponse = await fetch(`${realHostUrl}/v1/backends`);
        assert.equal(hostBackendsResponse.status, 200);
        const hostBackendsJson = await hostBackendsResponse.json();
        assert.equal(hostBackendsJson.ok, true);
        assert(hostBackendsJson.data.some((backend) => backend.id === 'mtplx'));

        const hostBackendCatalogResponse = await fetch(`${realHostUrl}/v1/backends/catalog`);
        assert.equal(hostBackendCatalogResponse.status, 200);
        assert(
          hostBackendCatalogResponse.headers
            .get('content-type')
            .includes('application/vnd.lloom.backend-catalog+json;version=1')
        );
        const hostBackendCatalogJson = await hostBackendCatalogResponse.json();
        assert.deepEqual(validateBackendCatalog(hostBackendCatalogJson), []);
        assert(
          hostBackendCatalogJson.backends.some(
            (backend) => backend.id === 'mtplx' && backend.setup.some((step) => step.action === 'python-venv')
          )
        );
        const hostBackendCatalogValidation = await validateInterchangeDocument(hostBackendCatalogJson, config);
        assert.equal(hostBackendCatalogValidation.ok, true);
        assert.equal(hostBackendCatalogValidation.kind, 'backendCatalog');
        const loadedRemoteBackendCatalog = await loadBackendCatalog(`${realHostUrl}/v1/backends/catalog`);
        assert.equal(loadedRemoteBackendCatalog.filePath, `${realHostUrl}/v1/backends/catalog`);
        assert(loadedRemoteBackendCatalog.backends.some((backend) => backend.id === 'mtplx'));
        const remoteBackendPlanCli = JSON.parse(
          (
            await runCommand(process.execPath, [
              path.join(process.cwd(), 'bin', 'lloom.mjs'),
              'backend-plan',
              'mtplx',
              '--backend-catalog',
              `${realHostUrl}/v1/backends/catalog`
            ])
          ).stdout
        );
        assert.equal(remoteBackendPlanCli.id, 'mtplx');
        assert(remoteBackendPlanCli.steps.some((step) => step.action === 'python-venv'));

        const hostKeysResponse = await fetch(`${realHostUrl}/v1/keys`);
        assert.equal(hostKeysResponse.status, 200);
        assert(hostKeysResponse.headers.get('content-type').includes(SIGNING_KEYS_MEDIA_TYPE));
        const hostKeysJson = await hostKeysResponse.json();
        const hostKeysValidation = await validateInterchangeDocument(hostKeysJson, config);
        assert.equal(hostKeysValidation.ok, true);
        assert.equal(hostKeysValidation.kind, 'signingKeys');
        assert.equal(hostKeysValidation.mediaType, SIGNING_KEYS_MEDIA_TYPE);
        assert.equal(hostKeysJson.$schema, 'https://lloom.dev/schemas/signing-keys.v1.schema.json');
        assert.equal(hostKeysJson.data[0].keyId, 'lloom-dev-seed');
        assert.equal(hostKeysJson.data[0].status, 'active');
        assert(hostKeysJson.data[0].publicKey.includes('BEGIN PUBLIC KEY'));

        const hostRecipesResponse = await fetch(`${realHostUrl}/v1/recipes?tag=qwen3.6`);
        assert.equal(hostRecipesResponse.status, 200);
        const hostRecipesJson = await hostRecipesResponse.json();
        assert(hostRecipesJson.data.some((recipe) => recipe.id === 'apple-silicon-qwen36-35b-a3b-mtplx'));
        assert(hostRecipesJson.data.some((recipe) => recipe.id === 'apple-silicon-qwen36-27b-mtplx'));
        assert(hostRecipesJson.data.some((recipe) => recipe.id === 'linux-nvidia-qwen36-27b-nvfp4-vllm'));

        const hostLeaderboardResponse = await fetch(
          `${realHostUrl}/v1/leaderboard?recipe=apple-silicon-qwen36-35b-a3b-mtplx`
        );
        assert.equal(hostLeaderboardResponse.status, 200);
        const hostLeaderboardJson = await hostLeaderboardResponse.json();
        assert(hostLeaderboardJson.data.some((result) => result.recipeId === 'apple-silicon-qwen36-35b-a3b-mtplx'));
        assert.equal(
          hostLeaderboardJson.data.find((result) => result.recipeId === 'apple-silicon-qwen36-35b-a3b-mtplx')?.workload
            .category,
          'agentic-coding'
        );
        const hostWorkloadLeaderboardResponse = await fetch(`${realHostUrl}/v1/leaderboard?workload=agentic-coding`);
        assert.equal(hostWorkloadLeaderboardResponse.status, 200);
        const hostWorkloadLeaderboardJson = await hostWorkloadLeaderboardResponse.json();
        assert.equal(hostWorkloadLeaderboardJson.count, 3);
        assert(
          hostWorkloadLeaderboardJson.data.some(
            (result) =>
              result.recipeId === 'linux-nvidia-qwen36-27b-nvfp4-vllm' &&
              result.backendId === 'vllm' &&
              result.machine?.accelerators?.includes('cuda')
          )
        );
        assert(
          hostWorkloadLeaderboardJson.data.every(
            (result) =>
              result.workload?.category === 'agentic-coding' || result.workload?.tags?.includes('agentic-coding')
          )
        );

        const hostBenchmarkResponse = await fetch(`${realHostUrl}/v1/benchmarks`, {
          method: 'POST',
          headers: {
            'content-type': 'application/vnd.lloom.benchmark-suite+json;version=1'
          },
          body: JSON.stringify(benchmarkSuite)
        });
        assert.equal(hostBenchmarkResponse.status, 202);
        assert(hostBenchmarkResponse.headers.get('content-type').includes(BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE));
        const hostBenchmarkJson = await hostBenchmarkResponse.json();
        assert.deepEqual(validateBenchmarkSubmissionResponse(hostBenchmarkJson), []);
        assert.equal(hostBenchmarkJson.accepted, true);
        assert.equal(hostBenchmarkJson.persisted, true);
        assert.equal(hostBenchmarkJson.count, 1);
        assert.equal(hostBenchmarkJson.submissions[0].id, benchmarkSuite.id);
        await fs.access(path.join(hostSubmissionsRoot, `${benchmarkSuite.id}.json`));

        const directBenchmarkPlan = await submitBenchmarkSuites(
          path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'),
          config,
          {
            hostUrl: realHostUrl
          }
        );
        assert.equal(directBenchmarkPlan.dryRun, true);
        assert.equal(directBenchmarkPlan.ok, true);
        assert.equal(directBenchmarkPlan.request.mediaType, 'application/vnd.lloom.benchmark-suite+json;version=1');
        const directBenchmarkSubmit = await submitBenchmarkSuites(
          path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'),
          config,
          {
            hostUrl: realHostUrl,
            dryRun: false,
            yes: true
          }
        );
        assert.equal(directBenchmarkSubmit.dryRun, false);
        assert.equal(directBenchmarkSubmit.status, 202);
        assert.equal(directBenchmarkSubmit.response.accepted, true);
        assert.equal(directBenchmarkSubmit.response.persisted, true);

        const hostRecipePackResponse = await fetch(`${realHostUrl}/v1/recipe-packs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/vnd.lloom.recipe-pack+json;version=1'
          },
          body: JSON.stringify(exportedDocument)
        });
        assert.equal(hostRecipePackResponse.status, 202);
        assert(hostRecipePackResponse.headers.get('content-type').includes(RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE));
        const hostRecipePackJson = await hostRecipePackResponse.json();
        assert.deepEqual(validateRecipePackSubmissionResponse(hostRecipePackJson), []);
        assert.equal(hostRecipePackJson.accepted, true);
        assert.equal(hostRecipePackJson.persisted, true);
        assert.equal(hostRecipePackJson.submissions[0].id, exportedDocument.id);
        assert.equal(hostRecipePackJson.submissions[0].recipeCount, 1);
        await fs.access(path.join(hostSubmissionsRoot, 'recipe-packs', `${exportedDocument.id}.json`));

        const directRecipeSubmit = await submitRecipePack(exportPath, config, {
          hostUrl: realHostUrl,
          dryRun: false,
          yes: true
        });
        assert.equal(directRecipeSubmit.dryRun, false);
        assert.equal(directRecipeSubmit.status, 202);
        assert.equal(directRecipeSubmit.response.accepted, true);

        const benchmarkSubmitCliPlan = JSON.parse(
          (
            await runCommand(process.execPath, [
              path.join(process.cwd(), 'bin', 'lloom.mjs'),
              'benchmark-submit',
              path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'),
              '--host',
              realHostUrl
            ])
          ).stdout
        );
        assert.equal(benchmarkSubmitCliPlan.dryRun, true);
        assert.equal(benchmarkSubmitCliPlan.ok, true);
        const benchmarkSubmitCliApply = JSON.parse(
          (
            await runCommand(process.execPath, [
              path.join(process.cwd(), 'bin', 'lloom.mjs'),
              'benchmark-submit',
              path.join(process.cwd(), 'benchmarks', 'community', 'apple-silicon-qwen36-m2max.json'),
              '--host',
              realHostUrl,
              '--apply',
              '--yes'
            ])
          ).stdout
        );
        assert.equal(benchmarkSubmitCliApply.dryRun, false);
        assert.equal(benchmarkSubmitCliApply.response.accepted, true);

        const recipeSubmitCliApply = JSON.parse(
          (
            await runCommand(process.execPath, [
              path.join(process.cwd(), 'bin', 'lloom.mjs'),
              'recipe-submit',
              exportPath,
              '--host',
              realHostUrl,
              '--apply',
              '--yes'
            ])
          ).stdout
        );
        assert.equal(recipeSubmitCliApply.dryRun, false);
        assert.equal(recipeSubmitCliApply.response.accepted, true);

        const hostPackResponse = await fetch(`${realHostUrl}/v1/recipe-packs/apple-silicon-qwen36-35b-a3b-mtplx-pack`);
        assert.equal(hostPackResponse.status, 200);
        assert(hostPackResponse.headers.get('content-type').includes(RECIPE_PACK_MEDIA_TYPE));
        const hostPackJson = await hostPackResponse.json();
        assert.equal(hostPackJson.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.equal(hostPackJson.recipes[0].recipe.id, 'apple-silicon-qwen36-35b-a3b-mtplx');
        const hostPackModel = hostPackJson.recipes[0].recipe.models[0];
        assert.equal(hostPackModel.backendConfig, 'mtplx-35b-a3b');
        assert.deepEqual(hostPackModel.input, ['text', 'image']);
        assert.equal(hostPackModel.settings.maxOutputTokens, 32768);
        assert.equal(hostPackModel.settings.sessionCache, true);
        assert.equal(hostPackModel.settings.runtime.command, 'mtplx');
        assert(hostPackModel.settings.runtime.args.includes('${modelPath}'));
        assert(hostPackModel.settings.runtime.args.includes('${modelId}'));
        assert.equal(hostPackJson.signatures[0].keyId, 'lloom-dev-seed');
        assert(hostPackJson.signatures[0].publicKey.includes('BEGIN PUBLIC KEY'));

        const hostMissingPackResponse = await fetch(`${realHostUrl}/v1/recipe-packs/missing-pack`);
        assert.equal(hostMissingPackResponse.status, 404);
        assert(hostMissingPackResponse.headers.get('content-type').includes(ERROR_RESPONSE_MEDIA_TYPE));
        const hostMissingPackJson = await hostMissingPackResponse.json();
        const hostMissingPackValidation = await validateInterchangeDocument(hostMissingPackJson, config);
        assert.equal(hostMissingPackValidation.ok, true);
        assert.equal(hostMissingPackValidation.kind, 'errorResponse');
        assert.equal(hostMissingPackJson.error.code, 'not_found');
        assert.equal(hostMissingPackJson.error.status, 404);

        const mixedRecipesRoot = path.join(tempDir, 'mixed-host-recipes');
        const mixedBenchmarksRoot = path.join(tempDir, 'mixed-host-benchmarks');
        await fs.mkdir(mixedRecipesRoot, { recursive: true });
        await fs.mkdir(mixedBenchmarksRoot, { recursive: true });
        const mixedRecipe = {
          $schema: 'https://lloom.dev/schemas/recipe.v1.schema.json',
          schemaVersion: 1,
          id: 'mixed-hardware-agent',
          name: 'Mixed Hardware Agent',
          version: 1,
          summary: 'Synthetic recipe with mixed Apple and CUDA benchmark evidence.',
          keywords: ['agentic-coding', 'coding-agent', 'long-context'],
          capabilities: ['chat', 'responses', 'anthropic-messages', 'streaming', 'tools', 'reasoning', 'long-context'],
          requirements: {
            platforms: ['darwin-arm64', 'linux-x64'],
            memoryGb: 16
          },
          backend: {
            id: 'openai-compatible',
            name: 'OpenAI-compatible'
          },
          setup: {
            steps: []
          },
          models: [
            {
              role: 'default',
              model: 'example/mixed-hardware-agent',
              gatewayModel: 'example/mixed-hardware-agent',
              runtime: 'mixed-hardware-agent',
              backend: 'OpenAI-compatible',
              capabilities: ['chat', 'tools', 'reasoning', 'long-context'],
              settings: {
                contextWindow: 262144
              }
            }
          ]
        };
        await fs.writeFile(
          path.join(mixedRecipesRoot, 'mixed-hardware-agent.json'),
          `${JSON.stringify(mixedRecipe, null, 2)}\n`,
          'utf8'
        );
        await fs.writeFile(
          path.join(mixedRecipesRoot, 'index.json'),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              id: 'mixed-host-recipes',
              name: 'Mixed host recipes',
              recipes: [
                {
                  id: 'mixed-hardware-agent',
                  path: 'mixed-hardware-agent.json',
                  name: 'Mixed Hardware Agent',
                  tags: ['agentic-coding', 'coding-agent', 'long-context'],
                  capabilities: ['chat', 'tools', 'reasoning', 'long-context']
                }
              ]
            },
            null,
            2
          )}\n`,
          'utf8'
        );
        await fs.writeFile(
          path.join(mixedBenchmarksRoot, 'mixed-hardware-agent.json'),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              id: 'mixed-hardware-agent-benchmarks',
              name: 'Mixed Hardware Agent Benchmarks',
              submittedAt: '2026-07-08T00:00:00Z',
              results: [
                {
                  id: 'mixed-hardware-agent-cuda-fast',
                  recipeId: 'mixed-hardware-agent',
                  backendId: 'openai-compatible',
                  model: 'example/mixed-hardware-agent',
                  gatewayModel: 'example/mixed-hardware-agent',
                  machine: {
                    platformId: 'linux-x64',
                    chip: 'Synthetic Blackwell',
                    memoryGb: 128,
                    accelerators: ['cuda', 'nvidia-gpu'],
                    devices: [
                      {
                        id: 'cuda:0',
                        kind: 'gpu',
                        vendor: 'nvidia',
                        name: 'Synthetic NVIDIA GPU',
                        backend: 'cuda',
                        memoryGb: 96,
                        accelerators: ['cuda', 'nvidia-gpu']
                      }
                    ]
                  },
                  workload: {
                    category: 'agentic-coding',
                    tags: ['agentic-coding', 'coding-agent', 'long-context']
                  },
                  metrics: {
                    generationTokPerSec: 500,
                    contextWindow: 262144
                  }
                },
                {
                  id: 'mixed-hardware-agent-apple-slow',
                  recipeId: 'mixed-hardware-agent',
                  backendId: 'openai-compatible',
                  model: 'example/mixed-hardware-agent',
                  gatewayModel: 'example/mixed-hardware-agent',
                  machine: {
                    platformId: 'darwin-arm64',
                    chip: 'Apple M2 Max',
                    memoryGb: 96,
                    accelerators: ['apple-gpu', 'metal'],
                    devices: [
                      {
                        id: 'apple-gpu',
                        kind: 'gpu',
                        vendor: 'apple',
                        name: 'Apple GPU',
                        backend: 'metal',
                        accelerators: ['apple-gpu', 'metal']
                      }
                    ]
                  },
                  workload: {
                    category: 'agentic-coding',
                    tags: ['agentic-coding', 'coding-agent', 'long-context']
                  },
                  metrics: {
                    generationTokPerSec: 1,
                    contextWindow: 262144
                  }
                }
              ]
            },
            null,
            2
          )}\n`,
          'utf8'
        );
        const mixedHost = createLloomHostServer(config, {
          port: 0,
          indexPath: path.join(mixedRecipesRoot, 'index.json'),
          recipesRoot: mixedRecipesRoot,
          benchmarksRoot: mixedBenchmarksRoot
        });
        const mixedHostListened = await tryListen(mixedHost.server);
        if (mixedHostListened) {
          const mixedHostUrl = `http://127.0.0.1:${mixedHost.server.address().port}`;
          try {
            const mixedMacResponse = await fetch(
              `${mixedHostUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&gpu_vendor=apple&gpu_backend=metal&workload=agentic-coding&limit=1`
            );
            assert.equal(mixedMacResponse.status, 200);
            const mixedMacJson = await mixedMacResponse.json();
            assert.equal(mixedMacJson.recommendations[0].benchmark.id, 'mixed-hardware-agent-apple-slow');
            assert.equal(mixedMacJson.recommendations[0].benchmark.machineMatch.platformMatched, true);
            assert(mixedMacJson.recommendations[0].benchmark.machineMatch.acceleratorOverlap.includes('apple-gpu'));
            assert.equal(mixedMacJson.recommendations[0].benchmark.metrics.generationTokPerSec, 1);

            const mixedCudaResponse = await fetch(
              `${mixedHostUrl}/v1/recipe-packs/recommended?platform=linux-x64&memory_gb=128&accelerator=cuda&gpu_vendor=nvidia&gpu_backend=cuda&workload=agentic-coding&limit=1`
            );
            assert.equal(mixedCudaResponse.status, 200);
            const mixedCudaJson = await mixedCudaResponse.json();
            assert.equal(mixedCudaJson.recommendations[0].benchmark.id, 'mixed-hardware-agent-cuda-fast');
            assert.equal(mixedCudaJson.recommendations[0].benchmark.machineMatch.platformMatched, true);
            assert(mixedCudaJson.recommendations[0].benchmark.machineMatch.acceleratorOverlap.includes('cuda'));
            assert.equal(mixedCudaJson.recommendations[0].benchmark.metrics.generationTokPerSec, 500);
          } finally {
            await closeServer(mixedHost.server);
          }
        }

        const hostRecommendedResponse = await fetch(
          `${realHostUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&gpu_count=1&gpu_vendor=apple&gpu_backend=metal&limit=1`
        );
        assert.equal(hostRecommendedResponse.status, 200);
        assert(hostRecommendedResponse.headers.get('content-type').includes(RECOMMENDATION_RESPONSE_MEDIA_TYPE));
        const hostRecommendedJson = await hostRecommendedResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedJson), []);
        assert.equal(hostRecommendedJson.$schema, 'https://lloom.dev/schemas/recommendation-response.v1.schema.json');
        assert.equal(hostRecommendedJson.machineProfile.platformId, 'darwin-arm64');
        assert(hostRecommendedJson.machineProfile.accelerators.includes('apple-gpu'));
        assert(
          hostRecommendedJson.machineProfile.devices.some(
            (device) => device.kind === 'gpu' && device.vendor === 'apple' && device.backend === 'metal'
          )
        );
        assert.equal(hostRecommendedJson.recommendationCount, 1);
        assert.equal(hostRecommendedJson.recommendations[0].pack.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.equal(hostRecommendedJson.recommendations[0].pack.signatures[0].keyId, 'lloom-dev-seed');
        assert.equal(
          hostRecommendedJson.recommendations[0].benchmark.id,
          'qwen36-35b-a3b-mtplx-speed-fp16-m2max-d1-seed'
        );
        assert.equal(hostRecommendedJson.recommendations[0].benchmark.metrics.generationTokPerSec, 68.58);
        assert.equal(
          hostRecommendedJson.recommendations[0].evaluation.selection.benchmarkScore,
          hostRecommendedJson.recommendations[0].benchmark.score
        );
        const hostRecommendedValidation = await validateInterchangeDocument(hostRecommendedJson, config);
        assert.equal(hostRecommendedValidation.ok, true);
        assert.equal(hostRecommendedValidation.kind, 'recommendationResponse');

        const hostRecommendedCudaResponse = await fetch(
          `${realHostUrl}/v1/recipe-packs/recommended?platform=linux-arm64&memory_gb=128&accelerator=cuda&accelerator=nvidia-gpu&gpu_count=1&gpu_vendor=nvidia&gpu_backend=cuda&workload=agentic-coding&capability=tools&capability=reasoning&capability=long-context&limit=1`
        );
        assert.equal(hostRecommendedCudaResponse.status, 200);
        const hostRecommendedCudaJson = await hostRecommendedCudaResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedCudaJson), []);
        assert.equal(hostRecommendedCudaJson.machineProfile.platformId, 'linux-arm64');
        assert.equal(hostRecommendedCudaJson.recommendations[0].pack.id, 'linux-nvidia-qwen36-27b-nvfp4-vllm-pack');
        assert.equal(
          hostRecommendedCudaJson.recommendations[0].benchmark.id,
          'qwen36-27b-nvfp4-vllm-dgx-spark-c4-seed'
        );
        assert.equal(hostRecommendedCudaJson.recommendations[0].benchmark.metrics.generationTokPerSec, 98.1);
        assert(hostRecommendedCudaJson.recommendations[0].benchmark.machineMatch.acceleratorOverlap.includes('cuda'));

        const hostRecommendedPostResponse = await fetch(`${realHostUrl}/v1/recipe-packs/recommended`, {
          method: 'POST',
          headers: {
            'content-type': RECOMMENDATION_REQUEST_MEDIA_TYPE,
            accept: RECOMMENDATION_RESPONSE_MEDIA_TYPE
          },
          body: JSON.stringify({
            $schema: 'https://lloom.dev/schemas/recommendation-request.v1.schema.json',
            schemaVersion: 1,
            profile: 'https://lloom.dev/profiles/interchange/v1',
            id: 'recommend-post-darwin-arm64-96gb',
            machineProfile: {
              $schema: 'https://lloom.dev/schemas/machine-profile.v1.schema.json',
              schemaVersion: 1,
              profile: 'https://lloom.dev/profiles/interchange/v1',
              id: 'post-darwin-arm64-96gb',
              platform: 'darwin',
              arch: 'arm64',
              platformId: 'darwin-arm64',
              totalMemoryGb: 96,
              accelerators: ['apple-gpu', 'metal'],
              devices: [
                {
                  id: 'apple-gpu',
                  kind: 'gpu',
                  vendor: 'apple',
                  name: 'Apple GPU',
                  backend: 'metal',
                  accelerators: ['apple-gpu', 'metal']
                }
              ]
            },
            request: {
              filters: {
                workloads: ['agentic-coding'],
                capabilities: ['tools', 'reasoning', 'long-context'],
                tags: ['coding-agent']
              }
            },
            limit: 1
          })
        });
        assert.equal(hostRecommendedPostResponse.status, 200);
        assert(hostRecommendedPostResponse.headers.get('content-type').includes(RECOMMENDATION_RESPONSE_MEDIA_TYPE));
        const hostRecommendedPostJson = await hostRecommendedPostResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedPostJson), []);
        assert.equal(hostRecommendedPostJson.machineProfile.id, 'post-darwin-arm64-96gb');
        assert.equal(hostRecommendedPostJson.recommendations[0].pack.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.deepEqual(hostRecommendedPostJson.request.filters.tags, ['coding-agent']);
        assert.equal(
          hostRecommendedPostJson.recommendations[0].evaluation.selection.filters.capabilities[2],
          'long-context'
        );
        const hostRecommendedPostValidation = await validateInterchangeDocument(hostRecommendedPostJson, config);
        assert.equal(hostRecommendedPostValidation.ok, true);
        assert.equal(hostRecommendedPostValidation.kind, 'recommendationResponse');

        const hostRecommendedPostBadRequest = await fetch(`${realHostUrl}/v1/recipe-packs/recommended`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            limit: 1
          })
        });
        assert.equal(hostRecommendedPostBadRequest.status, 400);
        assert(hostRecommendedPostBadRequest.headers.get('content-type').includes(ERROR_RESPONSE_MEDIA_TYPE));
        const hostRecommendedPostBadJson = await hostRecommendedPostBadRequest.json();
        assert.equal(hostRecommendedPostBadJson.error.code, 'bad_request');
        assert(hostRecommendedPostBadJson.error.message.includes('machineProfile'));

        const hostRecommendedUnknownMemoryResponse = await fetch(
          `${realHostUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&accelerator=apple-gpu&gpu_count=1&gpu_vendor=apple&gpu_backend=metal&limit=1`
        );
        assert.equal(hostRecommendedUnknownMemoryResponse.status, 200);
        const hostRecommendedUnknownMemoryJson = await hostRecommendedUnknownMemoryResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedUnknownMemoryJson), []);
        assert.equal(Object.hasOwn(hostRecommendedUnknownMemoryJson.machineProfile, 'totalMemoryGb'), false);
        assert.equal(hostRecommendedUnknownMemoryJson.recommendationCount, 1);
        assert.equal(
          hostRecommendedUnknownMemoryJson.recommendations[0].pack.id,
          'apple-silicon-qwen36-35b-a3b-mtplx-pack'
        );
        assert.equal(hostRecommendedUnknownMemoryJson.recommendations[0].evaluation.memorySupported, null);
        assert(
          hostRecommendedUnknownMemoryJson.recommendations[0].evaluation.reasons.some(
            (reason) => reason === 'memory unknown; recipe requires 80 GB'
          )
        );
        const hostRecommendedUnknownMemoryValidation = await validateInterchangeDocument(
          hostRecommendedUnknownMemoryJson,
          config
        );
        assert.equal(hostRecommendedUnknownMemoryValidation.ok, true);

        const hostRecommendedFilteredResponse = await fetch(
          `${realHostUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&workload=agentic-coding&capability=tools&capability=reasoning&tag=coding-agent&limit=1`
        );
        assert.equal(hostRecommendedFilteredResponse.status, 200);
        const hostRecommendedFilteredJson = await hostRecommendedFilteredResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedFilteredJson), []);
        assert.deepEqual(hostRecommendedFilteredJson.request.filters.workloads, ['agentic-coding']);
        assert.deepEqual(hostRecommendedFilteredJson.request.filters.capabilities, ['tools', 'reasoning']);
        assert.deepEqual(hostRecommendedFilteredJson.request.filters.tags, ['coding-agent']);
        assert.equal(hostRecommendedFilteredJson.recommendations[0].pack.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.deepEqual(hostRecommendedFilteredJson.recommendations[0].request.workloads, ['agentic-coding']);
        assert.equal(hostRecommendedFilteredJson.recommendations[0].benchmark.workload.category, 'agentic-coding');
        assert.equal(
          hostRecommendedFilteredJson.recommendations[0].evaluation.selection.filters.workloads[0],
          'agentic-coding'
        );

        const hostRecommendedLowMemoryResponse = await fetch(
          `${realHostUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=64&limit=1`
        );
        assert.equal(hostRecommendedLowMemoryResponse.status, 200);
        const hostRecommendedLowMemoryJson = await hostRecommendedLowMemoryResponse.json();
        assert.deepEqual(validateRecommendationResponse(hostRecommendedLowMemoryJson), []);
        assert.equal(hostRecommendedLowMemoryJson.recommendations[0].pack.id, 'apple-silicon-qwen36-27b-mtplx-pack');
        assert.equal(
          hostRecommendedLowMemoryJson.recommendations[0].benchmark.id,
          'qwen36-27b-mtplx-speed-m2max-d3-seed'
        );

        const realHostCommunityPlan = await createCommunityPlan(config, {
          hostUrl: realHostUrl,
          requireSignature: true,
          profile: {
            platformId: 'darwin-arm64',
            platform: 'darwin',
            arch: 'arm64',
            totalMemoryGb: 96
          },
          indexPath: path.join(tempDir, 'real-host-community-recipes', 'index.json'),
          recipesRoot: path.join(tempDir, 'real-host-community-recipes'),
          benchmarksRoot: path.join(tempDir, 'real-host-community-benchmarks')
        });
        assert.equal(realHostCommunityPlan.ok, true);
        assert.equal(realHostCommunityPlan.host.autoStarted, null);
        assert.equal(realHostCommunityPlan.backendCatalogPath, `${realHostUrl}/v1/backends/catalog`);
        assert.equal(realHostCommunityPlan.host.backendCatalogPath, `${realHostUrl}/v1/backends/catalog`);
        assert.equal(realHostCommunityPlan.host.requestMethod, 'POST');
        assert.equal(realHostCommunityPlan.host.requestUrl, `${realHostUrl}/v1/recipe-packs/recommended`);
        assert.equal(realHostCommunityPlan.host.signingKeys.status, 'loaded');
        assert.equal(realHostCommunityPlan.host.signingKeys.url, `${realHostUrl}/v1/keys`);
        assert.deepEqual(realHostCommunityPlan.host.signingKeys.keyIds, ['lloom-dev-seed']);
        assert.equal(
          realHostCommunityPlan.host.request.$schema,
          'https://lloom.dev/schemas/recommendation-request.v1.schema.json'
        );
        assert.equal(realHostCommunityPlan.host.request.machineProfile.platformId, 'darwin-arm64');
        assert(realHostCommunityPlan.host.request.machineProfile.accelerators.includes('apple-gpu'));
        assert(realHostCommunityPlan.host.fallbackRequestUrl.includes('accelerator=apple-gpu'));
        assert(realHostCommunityPlan.host.fallbackRequestUrl.includes('gpu_vendor=apple'));
        assert.equal(realHostCommunityPlan.plans[0].recommendation.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.equal(realHostCommunityPlan.plans[0].plan.pack.recipeCount, 1);
        assert.equal(realHostCommunityPlan.plans[0].plan.signature.signed, true);
        assert.equal(realHostCommunityPlan.plans[0].plan.signature.verified, true);
        assert.equal(realHostCommunityPlan.plans[0].plan.signature.trusted, true);

        const untrustedHostCommunityPlan = await createCommunityPlan(config, {
          hostUrl: realHostUrl,
          requireSignature: true,
          trustHostKeys: false,
          profile: {
            platformId: 'darwin-arm64',
            platform: 'darwin',
            arch: 'arm64',
            totalMemoryGb: 96
          },
          indexPath: path.join(tempDir, 'real-host-untrusted-community-recipes', 'index.json'),
          recipesRoot: path.join(tempDir, 'real-host-untrusted-community-recipes'),
          benchmarksRoot: path.join(tempDir, 'real-host-untrusted-community-benchmarks')
        });
        assert.equal(untrustedHostCommunityPlan.ok, true);
        assert.equal(untrustedHostCommunityPlan.host.signingKeys.status, 'disabled');
        assert.equal(untrustedHostCommunityPlan.plans[0].plan.signature.signed, true);
        assert.equal(untrustedHostCommunityPlan.plans[0].plan.signature.verified, true);
        assert.equal(untrustedHostCommunityPlan.plans[0].plan.signature.trusted, false);
      } finally {
        await closeServer(realHost.server);
      }
    }

    const ephemeralKeyHost = createLloomHostServer(config, {
      port: 0,
      privateKeyPath: path.join(tempDir, 'missing-dev-private.pem'),
      publicKeyPath: path.join(tempDir, 'missing-dev-public.pem')
    });
    const ephemeralKeyHostListened = await tryListen(ephemeralKeyHost.server);
    if (ephemeralKeyHostListened) {
      const ephemeralKeyHostUrl = `http://127.0.0.1:${ephemeralKeyHost.server.address().port}`;
      try {
        const ephemeralKeysResponse = await fetch(`${ephemeralKeyHostUrl}/v1/keys`);
        assert.equal(ephemeralKeysResponse.status, 200);
        const ephemeralKeysJson = await ephemeralKeysResponse.json();
        assert.equal(ephemeralKeysJson.data[0].keyId, 'lloom-dev-seed');
        assert.equal(ephemeralKeysJson.data[0].ephemeral, true);
        assert(ephemeralKeysJson.data[0].publicKey.includes('BEGIN PUBLIC KEY'));

        const ephemeralCommunityPlan = await createCommunityPlan(config, {
          hostUrl: ephemeralKeyHostUrl,
          requireSignature: true,
          profile: {
            platformId: 'darwin-arm64',
            platform: 'darwin',
            arch: 'arm64',
            totalMemoryGb: 96,
            accelerators: ['apple-gpu', 'metal'],
            devices: [
              {
                id: 'apple-gpu',
                kind: 'gpu',
                vendor: 'apple',
                name: 'Apple GPU',
                backend: 'metal',
                accelerators: ['apple-gpu', 'metal']
              }
            ]
          },
          indexPath: path.join(tempDir, 'ephemeral-host-community-recipes', 'index.json'),
          recipesRoot: path.join(tempDir, 'ephemeral-host-community-recipes'),
          benchmarksRoot: path.join(tempDir, 'ephemeral-host-community-benchmarks')
        });
        assert.equal(ephemeralCommunityPlan.ok, true);
        assert.equal(ephemeralCommunityPlan.host.requestMethod, 'POST');
        assert.equal(ephemeralCommunityPlan.host.signingKeys.status, 'loaded');
        assert.equal(ephemeralCommunityPlan.host.signingKeys.ephemeral, true);
        assert.equal(ephemeralCommunityPlan.plans[0].plan.signature.signed, true);
        assert.equal(ephemeralCommunityPlan.plans[0].plan.signature.verified, true);
        assert.equal(ephemeralCommunityPlan.plans[0].plan.signature.trusted, true);
      } finally {
        await closeServer(ephemeralKeyHost.server);
      }
    }

    const autoHostPort = await allocatePort();
    if (autoHostPort) {
      const autoHostRecipesRoot = path.join(tempDir, 'auto-host-community-cache-recipes');
      const autoHostBenchmarksRoot = path.join(tempDir, 'auto-host-community-cache-benchmarks');
      const autoHostPlan = await createCommunityPlan(config, {
        hostUrl: `http://127.0.0.1:${autoHostPort}`,
        requireSignature: true,
        localHostStartupTimeoutMs: 5000,
        profile: {
          platformId: 'darwin-arm64',
          platform: 'darwin',
          arch: 'arm64',
          totalMemoryGb: 96,
          accelerators: ['apple-gpu', 'metal'],
          devices: [
            {
              id: 'apple-gpu',
              kind: 'gpu',
              vendor: 'apple',
              name: 'Apple GPU',
              backend: 'metal',
              accelerators: ['apple-gpu', 'metal']
            }
          ]
        },
        indexPath: path.join(autoHostRecipesRoot, 'index.json'),
        recipesRoot: autoHostRecipesRoot,
        benchmarksRoot: autoHostBenchmarksRoot
      });
      try {
        assert.equal(autoHostPlan.ok, true);
        assert(autoHostPlan.host.autoStarted.pid);
        assert.equal(autoHostPlan.host.autoStarted.health.data.recipeCount, 12);
        assert.equal(autoHostPlan.plans[0].recommendation.id, 'apple-silicon-qwen36-35b-a3b-mtplx-pack');
        assert.equal(autoHostPlan.plans[0].plan.roots.recipesRoot, autoHostRecipesRoot);
        assert.equal(autoHostPlan.plans[0].plan.roots.benchmarksRoot, autoHostBenchmarksRoot);
      } finally {
        try {
          process.kill(autoHostPlan.host.autoStarted.pid);
        } catch (error) {
          // eslint-disable-next-line no-unsafe-finally
          if (error?.code !== 'ESRCH') throw error;
        }
      }
    }

    const libraryResponse = await fetch(
      `http://127.0.0.1:${port}/gateway/library?model_root=${encodeURIComponent('/models')}`
    );
    assert.equal(libraryResponse.status, 200);
    const libraryPlanJson = await libraryResponse.json();
    assert.equal(libraryPlanJson.index.id, 'lloom-community-recipes');
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      assert.equal(libraryPlanJson.selected.recipeId, 'apple-silicon-qwen36-35b-a3b-optiq');
    } else {
      assert.equal(libraryPlanJson.selected, null);
    }
    assert.equal(
      libraryPlanJson.recipes.find((recipe) => recipe.id === 'apple-silicon-qwen36-35b-a3b-optiq')?.commands
        .installApply,
      'lloom install apple-silicon-qwen36-35b-a3b-optiq --model-root /models --apply --yes'
    );

    const backendsResponse = await fetch(`http://127.0.0.1:${port}/gateway/backends`);
    assert.equal(backendsResponse.status, 200);
    const backendsJson = await backendsResponse.json();
    assert(backendsJson.backends.some((backend) => backend.id === 'mtplx'));
    assert(backendsJson.backends.some((backend) => backend.id === 'llama-cpp'));
    assert.equal(backendsJson.catalog.count, backendCatalog.backends.length);

    const backendPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/backends/mtplx/plan`);
    assert.equal(backendPlanResponse.status, 200);
    const backendPlanJson = await backendPlanResponse.json();
    assert.equal(backendPlanJson.id, 'mtplx');
    assert(backendPlanJson.steps.some((step) => step.id === 'link-mtplx'));

    const missingBackendPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/backends/nope/plan`);
    assert.equal(missingBackendPlanResponse.status, 404);

    const backendInstallRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/backends/mtplx/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(backendInstallRefusedResponse.status, 400);
    assert((await backendInstallRefusedResponse.text()).includes('Refusing to modify backend setup'));

    const setupPlanParams = new URLSearchParams({
      recipe: 'apple-silicon-qwen36',
      config_out: path.join(tempDir, 'server-setup-config.json'),
      model_root: '/models',
      port: '9102',
      backend_port_range: '9400-9499',
      client: 'omp',
      home: tempDir,
      generated_root: path.join(tempDir, 'server-setup-generated')
    });
    const setupPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/setup/plan?${setupPlanParams}`);
    assert.equal(setupPlanResponse.status, 200);
    const setupPlanJson = await setupPlanResponse.json();
    assert.equal(setupPlanJson.dryRun, true);
    assert.equal(setupPlanJson.phases.init.config.server.port, 9102);
    assert.equal(setupPlanJson.phases.init.config.runtimes['mtplx-qwen36-27b-speed'].port, 9400);
    assert(setupPlanJson.next.apply.includes("--backend-port-range '9400-9499'"));

    const modelImportPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/models/import-plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        modelRef: 'https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF/blob/main/Qwen3.6-27B-MTP-Q4_K_XL.gguf',
        modelRoot: '/models with spaces',
        port: 8404,
        contextWindow: 131072
      })
    });
    assert.equal(modelImportPlanResponse.status, 200);
    const modelImportPlanJson = await modelImportPlanResponse.json();
    assert.equal(modelImportPlanJson.inference.backend, 'llama-cpp');
    assert.equal(modelImportPlanJson.additions.port, 8404);
    assert(modelImportPlanJson.next.apply.includes("--context-window '131072'"));
    assert.equal(
      modelImportPlanJson.download.shellCommand,
      "'hf' 'download' 'unsloth/Qwen3.6-27B-MTP-GGUF' 'Qwen3.6-27B-MTP-Q4_K_XL.gguf' '--local-dir' '/models with spaces/unsloth--Qwen3.6-27B-MTP-GGUF'"
    );

    const missingModelImportPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/models/import-plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(missingModelImportPlanResponse.status, 400);

    const setupApplyRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/setup/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        recipe: 'apple-silicon-qwen36'
      })
    });
    assert.equal(setupApplyRefusedResponse.status, 400);
    assert((await setupApplyRefusedResponse.text()).includes('Refusing to run setup'));

    const modelImportRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/models/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        modelRef: 'qwen3:8b'
      })
    });
    assert.equal(modelImportRefusedResponse.status, 400);
    assert((await modelImportRefusedResponse.text()).includes('Refusing to modify LLooM config'));

    const serverImportConfigPath = path.join(tempDir, 'server-model-import-config.json');
    await fs.writeFile(serverImportConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const modelImportApplyResponse = await fetch(`http://127.0.0.1:${port}/gateway/models/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        modelRef: 'qwen3:8b',
        configPath: serverImportConfigPath,
        port: 11436,
        yes: true
      })
    });
    assert.equal(modelImportApplyResponse.status, 200);
    const modelImportApplyJson = await modelImportApplyResponse.json();
    assert.equal(modelImportApplyJson.dryRun, false);
    assert.equal(modelImportApplyJson.written.configPath, serverImportConfigPath);
    const serverWrittenImportConfig = JSON.parse(await fs.readFile(serverImportConfigPath, 'utf8'));
    assert(serverWrittenImportConfig.models.some((model) => model.id === 'qwen3:8b'));
    assert.equal(serverWrittenImportConfig.runtimes['ollama-qwen3-8b'].port, 11436);

    const serverPackRecipesRoot = path.join(tempDir, 'server-pack-recipes');
    const serverPackBenchmarksRoot = path.join(tempDir, 'server-pack-benchmarks');
    const serverPackIndexPath = path.join(serverPackRecipesRoot, 'index.json');
    const serverPackPayload = {
      source: packPath,
      indexPath: serverPackIndexPath,
      recipesRoot: serverPackRecipesRoot,
      benchmarksRoot: serverPackBenchmarksRoot,
      requireSignature: false
    };
    const recipePackPlanResponse = await fetch(`http://127.0.0.1:${port}/gateway/recipe-packs/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(serverPackPayload)
    });
    assert.equal(recipePackPlanResponse.status, 200);
    const recipePackPlanJson = await recipePackPlanResponse.json();
    assert.equal(recipePackPlanJson.ok, true);
    assert.equal(recipePackPlanJson.pack.recipeCount, 1);
    assert.equal(recipePackPlanJson.actions.find((action) => action.type === 'recipe').status, 'create');

    const recipePackImportRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/recipe-packs/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(serverPackPayload)
    });
    assert.equal(recipePackImportRefusedResponse.status, 400);
    assert((await recipePackImportRefusedResponse.text()).includes('Refusing to import recipe pack'));

    const recipePackImportResponse = await fetch(`http://127.0.0.1:${port}/gateway/recipe-packs/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        ...serverPackPayload,
        yes: true
      })
    });
    assert.equal(recipePackImportResponse.status, 200);
    const recipePackImportJson = await recipePackImportResponse.json();
    assert.equal(recipePackImportJson.dryRun, false);
    assert.equal(recipePackImportJson.results.filter((result) => result.status === 'written').length, 3);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(serverPackRecipesRoot, 'synthetic-pack.json'), 'utf8')).id,
      'synthetic-pack'
    );

    const communityHost = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/v1/recipe-packs/recommended') {
        if (req.method === 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        const packUrl = `http://127.0.0.1:${communityHost.address().port}/packs/synthetic-pack.json`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            packs: [
              {
                id: 'synthetic-pack',
                url: packUrl,
                score: 99,
                summary: 'Synthetic recommended pack.'
              }
            ]
          })
        );
        return;
      }
      if (requestUrl.pathname === '/packs/synthetic-pack.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(packDocument));
        return;
      }
      if (requestUrl.pathname === '/v1/backends/catalog') {
        res.writeHead(200, { 'content-type': 'application/vnd.lloom.backend-catalog+json;version=1' });
        res.end(JSON.stringify(backendCatalog));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    const communityListened = await tryListen(communityHost);
    if (communityListened) {
      const communityHostUrl = `http://127.0.0.1:${communityHost.address().port}`;
      try {
        const communityPlan = await createCommunityPlan(config, {
          hostUrl: communityHostUrl,
          requireSignature: false,
          indexPath: path.join(tempDir, 'direct-community-recipes', 'index.json'),
          recipesRoot: path.join(tempDir, 'direct-community-recipes'),
          benchmarksRoot: path.join(tempDir, 'direct-community-benchmarks')
        });
        assert.equal(communityPlan.ok, true);
        assert.equal(communityPlan.backendCatalogPath, `${communityHostUrl}/v1/backends/catalog`);
        assert.equal(communityPlan.host.requestMethod, 'GET');
        assert.equal(communityPlan.host.fallbackFromStatus, 405);
        assert.equal(communityPlan.recommendationCount, 1);
        assert.equal(communityPlan.plans[0].plan.pack.recipeCount, 1);

        const communityOnboardingRecipesRoot = path.join(tempDir, 'community-onboard-recipes');
        const communityOnboardingPlan = await createOnboardingPlan(config, {
          hostUrl: communityHostUrl,
          requireSignature: false,
          indexPath: path.join(communityOnboardingRecipesRoot, 'index.json'),
          recipesRoot: communityOnboardingRecipesRoot,
          benchmarksRoot: path.join(tempDir, 'community-onboard-benchmarks'),
          configPath: path.join(tempDir, 'community-onboard-config.json'),
          modelRoot: '/models',
          clientId: 'omp',
          home: tempDir,
          generatedRoot: path.join(tempDir, 'community-onboard-generated'),
          backendVariables: setupBackendVariables,
          includeRuntimes: false
        });
        assert.equal(communityOnboardingPlan.dryRun, true);
        assert.equal(communityOnboardingPlan.source, 'community');
        assert.equal(communityOnboardingPlan.selectedRecipe.id, 'synthetic-pack');
        assert.equal(communityOnboardingPlan.community.selectedCount, 1);
        assert.equal(communityOnboardingPlan.stages.find((stage) => stage.id === 'community').status, 'planned');
        assert.equal(communityOnboardingPlan.stages.find((stage) => stage.id === 'verify').status, 'planned');
        assert.equal(communityOnboardingPlan.next.doctor, null);
        assert.equal(communityOnboardingPlan.setup.phases.bootstrap.benchmarks.recipe[0].count, 1);
        assert.equal(communityOnboardingPlan.doctor.details.benchmarks.count, 1);
        assert(
          !communityOnboardingPlan.doctor.warnings.some((warning) => warning.message?.includes('no benchmark evidence'))
        );
        assert.deepEqual(
          communityOnboardingPlan.stages.find((stage) => stage.id === 'models').actions.map((action) => action.id),
          ['apply-community-onboarding']
        );
        assert(communityOnboardingPlan.next.apply.includes('--host'));
        assert(communityOnboardingPlan.next.apply.includes('--backend-catalog'));
        assert(communityOnboardingPlan.next.apply.includes(`${communityHostUrl}/v1/backends/catalog`));
        assert(communityOnboardingPlan.next.apply.includes(`--home '${tempDir}'`));
        assert(
          communityOnboardingPlan.next.apply.includes(
            `--generated-root '${path.join(tempDir, 'community-onboard-generated')}'`
          )
        );
        assert(communityOnboardingPlan.next.apply.includes('--recipes-root'));
        assert(!communityOnboardingPlan.next.apply.includes("--recipe 'synthetic-pack'"));

        const zeroRegistryCommunityConfig = communityOnlyConfig(config);
        const zeroRegistryRecipesRoot = path.join(tempDir, 'zero-registry-community-recipes');
        const zeroRegistryOnboardingPlan = await createOnboardingPlan(zeroRegistryCommunityConfig, {
          hostUrl: communityHostUrl,
          requireSignature: false,
          indexPath: path.join(zeroRegistryRecipesRoot, 'index.json'),
          recipesRoot: zeroRegistryRecipesRoot,
          benchmarksRoot: path.join(tempDir, 'zero-registry-community-benchmarks'),
          configPath: path.join(tempDir, 'zero-registry-community-config.json'),
          modelRoot: '/models',
          clientId: 'omp',
          home: tempDir,
          generatedRoot: path.join(tempDir, 'zero-registry-community-generated'),
          backendVariables: setupBackendVariables,
          includeRuntimes: false
        });
        assert.equal(zeroRegistryOnboardingPlan.source, 'community');
        assert.equal(zeroRegistryOnboardingPlan.selectedRecipe.id, 'synthetic-pack');
        assert.equal(
          zeroRegistryOnboardingPlan.setup.phases.init.config.defaults.chatModel,
          'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
        );
        assert.deepEqual(
          zeroRegistryOnboardingPlan.setup.phases.init.config.models.map((model) => model.id),
          ['Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed']
        );
        assert.equal(
          zeroRegistryOnboardingPlan.setup.phases.init.config.models[0].backend,
          'mtplx-youssofal-qwen3-6-27b-mtplx-optimized-speed'
        );
        assert.equal(
          zeroRegistryOnboardingPlan.setup.phases.init.config.runtimes['mtplx-qwen36-27b-speed'].args[2],
          '/models/Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed'
        );
        assert(
          zeroRegistryOnboardingPlan.setup.phases.init.config.runtimes['mtplx-qwen36-27b-speed'].args.includes(
            '--depth'
          )
        );
        assert.deepEqual(zeroRegistryOnboardingPlan.keepWarm, ['mtplx-qwen36-27b-speed']);
        assert.deepEqual(
          createRegistry(zeroRegistryOnboardingPlan.setup.phases.init.config)
            .openAIModels()
            .map((model) => model.id),
          ['Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed']
        );
        assert.equal(zeroRegistryOnboardingPlan.next.doctor, null);
        assert.deepEqual(
          zeroRegistryOnboardingPlan.stages.find((stage) => stage.id === 'clients').actions.map((action) => action.id),
          ['apply-community-onboarding']
        );

        const defaultCommunityConfig = structuredClone(config);
        defaultCommunityConfig.community.hostUrl = communityHostUrl;
        defaultCommunityConfig.community.requireSignedPacks = false;
        const implicitCommunityOnboardingPlan = await createOnboardingPlan(defaultCommunityConfig, {
          indexPath: path.join(tempDir, 'implicit-community-onboard-recipes', 'index.json'),
          recipesRoot: path.join(tempDir, 'implicit-community-onboard-recipes'),
          benchmarksRoot: path.join(tempDir, 'implicit-community-onboard-benchmarks'),
          configPath: path.join(tempDir, 'implicit-community-onboard-config.json'),
          modelRoot: '/models',
          clientId: 'omp',
          home: tempDir,
          generatedRoot: path.join(tempDir, 'implicit-community-onboard-generated'),
          backendVariables: setupBackendVariables,
          includeRuntimes: false
        });
        assert.equal(implicitCommunityOnboardingPlan.source, 'community');
        assert.equal(implicitCommunityOnboardingPlan.community.host.url, communityHostUrl);
        assert.equal(implicitCommunityOnboardingPlan.selectedRecipe.id, 'synthetic-pack');
        assert.deepEqual(
          implicitCommunityOnboardingPlan.setup.phases.init.config.models.map((model) => model.id),
          ['Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed']
        );
        assert.deepEqual(Object.keys(implicitCommunityOnboardingPlan.setup.phases.init.config.backends), [
          'mtplx-youssofal-qwen3-6-27b-mtplx-optimized-speed'
        ]);
        assert.equal(implicitCommunityOnboardingPlan.next.doctor, null);
        assert(implicitCommunityOnboardingPlan.next.apply.includes('--host'));
        assert(implicitCommunityOnboardingPlan.next.apply.includes(`--home '${tempDir}'`));
        assert(
          implicitCommunityOnboardingPlan.next.apply.includes(
            `--generated-root '${path.join(tempDir, 'implicit-community-onboard-generated')}'`
          )
        );

        const defaultCacheHome = path.join(tempDir, 'implicit-community-cache-home');
        const defaultCacheOnboardingPlan = await createOnboardingPlan(defaultCommunityConfig, {
          configPath: path.join(tempDir, 'implicit-community-cache-config.json'),
          modelRoot: '/models',
          clientId: 'omp',
          home: defaultCacheHome,
          generatedRoot: path.join(tempDir, 'implicit-community-cache-generated'),
          backendVariables: setupBackendVariables,
          includeRuntimes: false
        });
        assert.equal(defaultCacheOnboardingPlan.source, 'community');
        assert.deepEqual(
          defaultCacheOnboardingPlan.setup.phases.init.config.models.map((model) => model.id),
          ['Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed']
        );
        assert.equal(
          defaultCacheOnboardingPlan.community.plans[0].plan.roots.recipesRoot,
          path.join(defaultCacheHome, '.lloom', 'community', 'recipes')
        );
        assert.equal(
          defaultCacheOnboardingPlan.community.plans[0].plan.roots.indexPath,
          path.join(defaultCacheHome, '.lloom', 'community', 'recipes', 'index.json')
        );
        assert.equal(
          defaultCacheOnboardingPlan.community.plans[0].plan.roots.benchmarksRoot,
          path.join(defaultCacheHome, '.lloom', 'community', 'benchmarks')
        );
        assert(defaultCacheOnboardingPlan.next.apply.includes(`--home '${defaultCacheHome}'`));
        assert(
          defaultCacheOnboardingPlan.next.apply.includes(
            `--generated-root '${path.join(tempDir, 'implicit-community-cache-generated')}'`
          )
        );
        assert(!defaultCacheOnboardingPlan.next.apply.includes('--recipes-root'));
        assert(!defaultCacheOnboardingPlan.next.apply.includes('--index'));

        await assert.rejects(
          () =>
            applyCommunityRecommendations(config, {
              hostUrl: communityHostUrl,
              requireSignature: false,
              dryRun: false
            }),
          /Refusing to import community recommendations/
        );

        const communityParams = new URLSearchParams({
          host: communityHostUrl,
          require_signature: 'false',
          index: path.join(tempDir, 'server-community-recipes', 'index.json'),
          recipes_root: path.join(tempDir, 'server-community-recipes'),
          benchmarks_root: path.join(tempDir, 'server-community-benchmarks')
        });
        const communityPlanResponse = await fetch(
          `http://127.0.0.1:${port}/gateway/community/recommendations?${communityParams}`
        );
        assert.equal(communityPlanResponse.status, 200);
        const communityPlanJson = await communityPlanResponse.json();
        assert.equal(communityPlanJson.ok, true);
        assert.equal(communityPlanJson.backendCatalogPath, `${communityHostUrl}/v1/backends/catalog`);
        assert.deepEqual(communityPlanJson.request.workloads, ['agentic-coding']);
        assert.deepEqual(communityPlanJson.request.capabilities, ['tools', 'reasoning', 'long-context']);
        assert.equal(communityPlanJson.recommendationCount, 1);
        assert.equal(communityPlanJson.plans[0].plan.pack.recipeCount, 1);

        const communityOnboardParams = new URLSearchParams({
          host: communityHostUrl,
          require_signature: 'false',
          index: path.join(tempDir, 'server-community-onboard-recipes', 'index.json'),
          recipes_root: path.join(tempDir, 'server-community-onboard-recipes'),
          benchmarks_root: path.join(tempDir, 'server-community-onboard-benchmarks'),
          config_out: path.join(tempDir, 'server-community-onboard-config.json'),
          model_root: '/models',
          client: 'omp',
          home: tempDir,
          generated_root: path.join(tempDir, 'server-community-onboard-generated'),
          no_runtimes: 'true'
        });
        const communityOnboardResponse = await fetch(
          `http://127.0.0.1:${port}/gateway/onboarding/plan?${communityOnboardParams}`
        );
        assert.equal(communityOnboardResponse.status, 200);
        const communityOnboardJson = await communityOnboardResponse.json();
        assert.equal(communityOnboardJson.source, 'community');
        assert.equal(communityOnboardJson.selectedRecipe.id, 'synthetic-pack');
        assert.equal(communityOnboardJson.stages.find((stage) => stage.id === 'community').status, 'planned');
        assert.equal(communityOnboardJson.next.doctor, null);
        assert.deepEqual(
          communityOnboardJson.stages.find((stage) => stage.id === 'clients').actions.map((action) => action.id),
          ['apply-community-onboarding']
        );

        const communityStatusRecipesRoot = path.join(tempDir, 'server-community-status-recipes');
        const communityStatusBenchmarksRoot = path.join(tempDir, 'server-community-status-benchmarks');
        await fs.mkdir(communityStatusBenchmarksRoot, { recursive: true });
        await fs.writeFile(
          path.join(communityStatusBenchmarksRoot, 'synthetic-pack-benchmarks.json'),
          `${JSON.stringify(packedBenchmarkSuite, null, 2)}\n`,
          'utf8'
        );
        const communityStatusParams = new URLSearchParams({
          host: communityHostUrl,
          require_signature: 'false',
          index: path.join(communityStatusRecipesRoot, 'index.json'),
          recipes_root: communityStatusRecipesRoot,
          benchmarks_root: communityStatusBenchmarksRoot,
          model_root: '/models',
          client: 'omp',
          home: tempDir,
          generated_root: path.join(tempDir, 'server-community-status-generated'),
          no_runtimes: 'true'
        });
        const communitySetupStatusResponse = await fetch(
          `http://127.0.0.1:${port}/gateway/setup/status?${communityStatusParams}`
        );
        assert.equal(communitySetupStatusResponse.status, 200);
        const communitySetupStatusJson = await communitySetupStatusResponse.json();
        assert.equal(communitySetupStatusJson.selectedRecipe.id, 'synthetic-pack');
        assert.equal(communitySetupStatusJson.community.selectedRecipeId, 'synthetic-pack');
        assert.equal(
          communitySetupStatusJson.community.host.backendCatalogPath,
          `${communityHostUrl}/v1/backends/catalog`
        );
        assert(communitySetupStatusJson.next.setup.includes('--recipes-root'));
        assert(communitySetupStatusJson.next.setup.includes(communityStatusRecipesRoot));
        assert(communitySetupStatusJson.next.setup.includes(`${communityHostUrl}/v1/backends/catalog`));

        const communityDoctorResponse = await fetch(`http://127.0.0.1:${port}/gateway/doctor?${communityStatusParams}`);
        assert.equal(communityDoctorResponse.status, 200);
        const communityDoctorJson = await communityDoctorResponse.json();
        assert.equal(communityDoctorJson.selectedRecipe.id, 'synthetic-pack');
        assert.equal(communityDoctorJson.community.selectedRecipeId, 'synthetic-pack');
        assert.equal(communityDoctorJson.details.benchmarks.count, 1);
        assert.equal(communityDoctorJson.details.benchmarks.overview[0].id, 'synthetic-pack-d1');

        const communityImportRefusedResponse = await fetch(`http://127.0.0.1:${port}/gateway/community/import`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            host: communityHostUrl,
            requireSignature: false
          })
        });
        assert.equal(communityImportRefusedResponse.status, 400);
        assert((await communityImportRefusedResponse.text()).includes('Refusing to import community recommendations'));

        const communityImportRecipesRoot = path.join(tempDir, 'server-community-apply-recipes');
        const communityImportResponse = await fetch(`http://127.0.0.1:${port}/gateway/community/import`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            host: communityHostUrl,
            requireSignature: false,
            indexPath: path.join(communityImportRecipesRoot, 'index.json'),
            recipesRoot: communityImportRecipesRoot,
            benchmarksRoot: path.join(tempDir, 'server-community-apply-benchmarks'),
            yes: true
          })
        });
        assert.equal(communityImportResponse.status, 200);
        const communityImportJson = await communityImportResponse.json();
        assert.equal(communityImportJson.dryRun, false);
        assert.equal(communityImportJson.selectedCount, 1);
        assert.equal(
          JSON.parse(await fs.readFile(path.join(communityImportRecipesRoot, 'synthetic-pack.json'), 'utf8')).id,
          'synthetic-pack'
        );

        const communityCli = await runCommand(process.execPath, [
          path.join(process.cwd(), 'bin', 'lloom.mjs'),
          'community',
          '--host',
          communityHostUrl,
          '--no-require-signature',
          '--index',
          path.join(tempDir, 'cli-community-recipes', 'index.json'),
          '--recipes-root',
          path.join(tempDir, 'cli-community-recipes'),
          '--benchmarks-root',
          path.join(tempDir, 'cli-community-benchmarks')
        ]);
        const communityCliJson = JSON.parse(communityCli.stdout);
        assert.equal(communityCliJson.ok, true);
        assert.equal(communityCliJson.plans[0].plan.pack.recipeCount, 1);

        const communityOnboardCli = await runCommand(process.execPath, [
          path.join(process.cwd(), 'bin', 'lloom.mjs'),
          'onboard',
          '--json',
          '--host',
          communityHostUrl,
          '--no-require-signature',
          '--index',
          path.join(tempDir, 'cli-community-onboard-recipes', 'index.json'),
          '--recipes-root',
          path.join(tempDir, 'cli-community-onboard-recipes'),
          '--benchmarks-root',
          path.join(tempDir, 'cli-community-onboard-benchmarks'),
          '--config-out',
          path.join(tempDir, 'cli-community-onboard-config.json'),
          '--model-root',
          '/models',
          '--client',
          'omp',
          '--home',
          tempDir,
          '--generated-root',
          path.join(tempDir, 'cli-community-onboard-generated'),
          '--no-runtimes'
        ]);
        const communityOnboardCliJson = JSON.parse(communityOnboardCli.stdout);
        assert.equal(communityOnboardCliJson.source, 'community');
        assert.equal(communityOnboardCliJson.selectedRecipe.id, 'synthetic-pack');
        assert(communityOnboardCliJson.next.apply.includes('--host'));
        assert(communityOnboardCliJson.next.apply.includes(`--home '${tempDir}'`));
        assert(
          communityOnboardCliJson.next.apply.includes(
            `--generated-root '${path.join(tempDir, 'cli-community-onboard-generated')}'`
          )
        );

        const communityHumanOnboardCli = await runCommand(process.execPath, [
          path.join(process.cwd(), 'bin', 'lloom.mjs'),
          'onboard',
          '--host',
          communityHostUrl,
          '--no-require-signature',
          '--index',
          path.join(tempDir, 'cli-community-human-onboard-recipes', 'index.json'),
          '--recipes-root',
          path.join(tempDir, 'cli-community-human-onboard-recipes'),
          '--benchmarks-root',
          path.join(tempDir, 'cli-community-human-onboard-benchmarks'),
          '--config-out',
          path.join(tempDir, 'cli-community-human-onboard-config.json'),
          '--model-root',
          '/models',
          '--client',
          'omp',
          '--home',
          tempDir,
          '--generated-root',
          path.join(tempDir, 'cli-community-human-onboard-generated'),
          '--no-runtimes'
        ]);
        assert(communityHumanOnboardCli.stdout.includes('Why this model: Synthetic recommended pack.'));
        assert(communityHumanOnboardCli.stdout.includes('Recommended model:'));
        assert(communityHumanOnboardCli.stdout.includes('Evidence:'));
      } finally {
        await closeServer(communityHost);
      }
    }
  } finally {
    await closeServer(app.server);
  }
}

const adminRuntimePort = await allocatePort();
if (adminRuntimePort) {
  const adminRuntimeScript = path.join(tempDir, 'synthetic-admin-runtime.mjs');
  await fs.writeFile(
    adminRuntimeScript,
    `
import http from "node:http";

const port = Number(process.argv[2]);
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_admin",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    'utf8'
  );
  const adminConfig = structuredClone(config);
  adminConfig.server = {
    host: '127.0.0.1',
    port: 0
  };
  adminConfig.runtimes = {
    'synthetic-admin-runtime': {
      enabled: false,
      command: process.execPath,
      args: [adminRuntimeScript, String(adminRuntimePort)],
      port: adminRuntimePort,
      healthUrl: `http://127.0.0.1:${adminRuntimePort}/health`,
      startupTimeoutMs: 5000,
      warmup: {
        url: `http://127.0.0.1:${adminRuntimePort}/v1/chat/completions`,
        body: {
          model: 'synthetic',
          messages: [{ role: 'user', content: 'warm up' }],
          max_tokens: 1
        }
      }
    }
  };
  adminConfig.runtimes['synthetic-admin-runtime'].keepWarm = true;
  const adminApp = createLloomServer(adminConfig, {
    logger: { error() {} }
  });
  const adminListened = await tryListen(adminApp.server);
  if (adminListened) {
    const { port } = adminApp.server.address();
    try {
      const admitDryRunResponse = await fetch(
        `http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/admit`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ warmup: false })
        }
      );
      assert.equal(admitDryRunResponse.status, 200);
      const admitDryRunJson = await admitDryRunResponse.json();
      assert.equal(admitDryRunJson.dryRun, true);
      assert(admitDryRunJson.results.some((result) => result.type === 'start' && result.status === 'planned'));

      const admitRefusedResponse = await fetch(
        `http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/admit`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apply: true, warmup: false })
        }
      );
      assert.equal(admitRefusedResponse.status, 400);
      assert((await admitRefusedResponse.text()).includes('without yes=true'));

      const startResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warmup: true })
      });
      assert.equal(startResponse.status, 200);
      const startJson = await startResponse.json();
      assert.equal(startJson.started, true);
      assert.equal(startJson.warmup.warmed, true);

      const warmupResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/warmup`, {
        method: 'POST'
      });
      assert.equal(warmupResponse.status, 200);
      const warmupJson = await warmupResponse.json();
      assert.equal(warmupJson.warmed, true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/gateway/status`);
      assert.equal(statusResponse.status, 200);
      const statusJson = await statusResponse.json();
      assert.equal(statusJson.runtimeManager.runtimes['synthetic-admin-runtime'].healthy, true);
      assert.equal(statusJson.runtimeManager.runtimes['synthetic-admin-runtime'].keepWarm, true);

      const stopResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/stop`, {
        method: 'POST'
      });
      assert.equal(stopResponse.status, 200);
      const stopJson = await stopResponse.json();
      assert.equal(stopJson.stopped, true);
    } finally {
      await closeServer(adminApp.server);
    }
  }
}

const autoBackendServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const body = await readJsonBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_auto_evict',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
const autoBackendListened = await tryListen(autoBackendServer);
if (autoBackendListened) {
  const autoOperations = [];
  const autoConfig = {
    server: {
      host: '127.0.0.1',
      port: 0
    },
    security: {
      allowMissingAuth: true,
      apiKeys: []
    },
    runtimePolicy: {
      autoEvict: true,
      memoryBudgetGb: 40,
      protectActiveRequests: true
    },
    defaults: {
      chatModel: 'auto-model'
    },
    runtimes: {
      'warm-runtime': {
        enabled: true,
        keepWarm: true,
        memoryGb: 25,
        policy: {
          priority: 100
        }
      },
      'big-runtime': {
        enabled: true,
        memoryGb: 30,
        policy: {
          priority: 200
        }
      }
    },
    backends: {
      'auto-backend': {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${autoBackendServer.address().port}/v1`
      }
    },
    models: [
      {
        id: 'auto-model',
        name: 'Auto Evict Model',
        backend: 'auto-backend',
        runtime: 'big-runtime',
        upstreamModel: 'auto-upstream',
        kind: 'chat',
        advertise: true
      }
    ]
  };
  const fakeAutoRuntimeManager = {
    async status() {
      return {
        runtimes: {
          'warm-runtime': {
            healthy: true,
            status: 'running',
            activeRequests: 0,
            queuedRequests: 0
          },
          'big-runtime': {
            healthy: false,
            status: 'idle',
            activeRequests: 0,
            queuedRequests: 0
          }
        }
      };
    },
    async withSlot(runtimeId, fn) {
      autoOperations.push(`slot:${runtimeId}`);
      return fn();
    },
    async stop(runtimeId) {
      autoOperations.push(`stop:${runtimeId}`);
      return { runtimeId, stopped: true };
    },
    async start(runtimeId, options) {
      autoOperations.push(`start:${runtimeId}:${options.reason}`);
      return { runtimeId, started: true, healthy: true };
    },
    async ensure() {
      throw new Error('ensure should not be called when autoEvict is enabled');
    }
  };
  const autoApp = createLloomServer(autoConfig, {
    runtimeManager: fakeAutoRuntimeManager,
    logger: { error() {} }
  });
  const autoAppListened = await tryListen(autoApp.server);
  if (autoAppListened) {
    const { port } = autoApp.server.address();
    try {
      const autoResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'auto-model',
          messages: [{ role: 'user', content: 'hello' }]
        })
      });
      assert.equal(autoResponse.status, 200);
      assert.equal((await autoResponse.json()).model, 'auto-model');
      assert.deepEqual(autoOperations, ['slot:big-runtime', 'stop:warm-runtime', 'start:big-runtime:model-request']);
    } finally {
      await closeServer(autoApp.server);
    }
  }
  await closeServer(autoBackendServer);
}

const speechUpstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/audio/speech') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const body = await readJsonBody(req);
  assert.equal(body.model, 'upstream-speech-model');
  assert.equal(body.input, 'Say hello.');
  // OpenAI voice aliases are normalized for Qwen CustomVoice backends.
  assert.equal(body.voice, 'serena');
  assert.equal(body.response_format, 'wav');
  res.writeHead(200, {
    'content-type': 'audio/wav'
  });
  res.end(Buffer.from('RIFFlloom-audio'));
});

const speechListened = await tryListen(speechUpstream);
if (speechListened) {
  const speechPort = speechUpstream.address().port;
  const speechConfig = structuredClone(config);
  speechConfig.server = {
    host: '127.0.0.1',
    port: 0
  };
  speechConfig.defaults.speechModel = 'synthetic-speech';
  speechConfig.backends['synthetic-speech'] = {
    type: 'openai',
    baseUrl: `http://127.0.0.1:${speechPort}/v1`,
    apiKey: 'sk-test'
  };
  speechConfig.models.push({
    id: 'synthetic-speech',
    name: 'Synthetic Speech',
    backend: 'synthetic-speech',
    upstreamModel: 'upstream-speech-model',
    kind: 'audio_speech',
    input: ['text'],
    output: ['audio'],
    capabilities: ['audio-speech'],
    advertise: true
  });
  const speechWrongKindModel = addSyntheticWrongKindChatModel(speechConfig, 'synthetic-speech');
  const speechApp = createLloomServer(speechConfig, {
    logger: { error() {} }
  });
  const speechGatewayListened = await tryListen(speechApp.server);
  if (speechGatewayListened) {
    const { port } = speechApp.server.address();
    try {
      const speechResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Say hello.',
          voice: 'alloy',
          response_format: 'wav'
        })
      });
      assert.equal(speechResponse.status, 200);
      assert.equal(speechResponse.headers.get('content-type'), 'audio/wav');
      assert.equal(Buffer.from(await speechResponse.arrayBuffer()).toString('utf8'), 'RIFFlloom-audio');

      const wrongKindResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: speechWrongKindModel,
          input: 'Say hello.'
        })
      });
      assert.equal(wrongKindResponse.status, 400);
      const wrongKindJson = await wrongKindResponse.json();
      assert.equal(wrongKindJson.error.code, 'wrong_model_kind');

      const catalogResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/speech/models`);
      assert.equal(catalogResponse.status, 200);
      const catalogJson = await catalogResponse.json();
      assert.equal(catalogJson.object, 'speech.catalog');
      assert.ok(catalogJson.models.some((model) => model.id === 'synthetic-speech'));

      const voicesResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/voices?model=synthetic-speech`);
      assert.equal(voicesResponse.status, 200);
      const voicesJson = await voicesResponse.json();
      assert.equal(voicesJson.object, 'list');

      const schemaResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/speech/schema?model=synthetic-speech`);
      assert.equal(schemaResponse.status, 200);
      const schemaJson = await schemaResponse.json();
      assert.equal(schemaJson.object, 'speech.schema');
      assert.ok(schemaJson.params?.input?.required);
    } finally {
      await closeServer(speechApp.server);
    }
  }
  await closeServer(speechUpstream);
}

// instructions → instruct normalization for upstream speech backends
{
  const instructUpstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/audio/speech') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const body = await readJsonBody(req);
    assert.equal(body.model, 'upstream-instruct-model');
    assert.equal(body.instructions, 'Cheerful tone');
    assert.equal(body.instruct, 'Cheerful tone');
    assert.equal(body.voice, 'serena'); // alloy alias
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(Buffer.from('RIFFinstruct'));
  });
  const instructListened = await tryListen(instructUpstream);
  if (instructListened) {
    const instructPort = instructUpstream.address().port;
    const instructConfig = structuredClone(config);
    instructConfig.server = { host: '127.0.0.1', port: 0 };
    instructConfig.defaults.speechModel = 'instruct-speech';
    instructConfig.backends['instruct-speech'] = {
      type: 'openai',
      baseUrl: `http://127.0.0.1:${instructPort}/v1`,
      apiKey: 'sk-test'
    };
    instructConfig.models.push({
      id: 'instruct-speech',
      name: 'Instruct Speech',
      backend: 'instruct-speech',
      upstreamModel: 'upstream-instruct-model',
      kind: 'audio_speech',
      input: ['text'],
      output: ['audio'],
      capabilities: ['audio-speech', 'tts', 'tts-custom-voice'],
      tts: { family: 'qwen3-tts', mode: 'custom_voice' },
      advertise: true
    });
    const instructApp = createLloomServer(instructConfig, { logger: { error() {} } });
    const instructGatewayListened = await tryListen(instructApp.server);
    if (instructGatewayListened) {
      const { port } = instructApp.server.address();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'Hello',
            voice: 'alloy',
            instructions: 'Cheerful tone',
            response_format: 'wav'
          })
        });
        assert.equal(response.status, 200);
        assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'RIFFinstruct');
      } finally {
        await closeServer(instructApp.server);
      }
    }
    await closeServer(instructUpstream);
  }
}

const embeddingUpstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const body = await readJsonBody(req);
  assert.equal(body.model, 'upstream-embedding-model');
  assert.deepEqual(body.input, ['hello', 'world']);
  res.writeHead(200, {
    'content-type': 'application/json'
  });
  res.end(
    JSON.stringify({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: [0.1, 0.2]
        },
        {
          object: 'embedding',
          index: 1,
          embedding: [0.3, 0.4]
        }
      ],
      model: 'upstream-embedding-model',
      usage: {
        prompt_tokens: 2,
        total_tokens: 2
      }
    })
  );
});

const embeddingListened = await tryListen(embeddingUpstream);
if (embeddingListened) {
  const embeddingPort = embeddingUpstream.address().port;
  const embeddingConfig = structuredClone(config);
  embeddingConfig.server = {
    host: '127.0.0.1',
    port: 0
  };
  embeddingConfig.defaults.embeddingModel = 'synthetic-embedding';
  embeddingConfig.backends['synthetic-embedding'] = {
    type: 'openai',
    baseUrl: `http://127.0.0.1:${embeddingPort}/v1`,
    apiKey: 'sk-test'
  };
  embeddingConfig.models.push({
    id: 'synthetic-embedding',
    name: 'Synthetic Embedding',
    backend: 'synthetic-embedding',
    upstreamModel: 'upstream-embedding-model',
    kind: 'embedding',
    input: ['text'],
    output: ['embedding'],
    capabilities: ['embeddings'],
    advertise: true
  });
  const embeddingWrongKindModel = addSyntheticWrongKindChatModel(embeddingConfig, 'synthetic-embedding');
  const embeddingApp = createLloomServer(embeddingConfig, {
    logger: { error() {} }
  });
  const embeddingGatewayListened = await tryListen(embeddingApp.server);
  if (embeddingGatewayListened) {
    const { port } = embeddingApp.server.address();
    try {
      const embeddingResponse = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'synthetic-embedding',
          input: ['hello', 'world']
        })
      });
      assert.equal(embeddingResponse.status, 200);
      const embeddingJson = await embeddingResponse.json();
      assert.equal(embeddingJson.data.length, 2);
      assert.deepEqual(embeddingJson.data[0].embedding, [0.1, 0.2]);

      const defaultEmbeddingResponse = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: ['hello', 'world']
        })
      });
      assert.equal(defaultEmbeddingResponse.status, 200);
      assert.equal((await defaultEmbeddingResponse.json()).usage.total_tokens, 2);

      const wrongKindResponse = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: embeddingWrongKindModel,
          input: 'hello'
        })
      });
      assert.equal(wrongKindResponse.status, 400);
      const wrongKindJson = await wrongKindResponse.json();
      assert.equal(wrongKindJson.error.code, 'wrong_model_kind');
    } finally {
      await closeServer(embeddingApp.server);
    }
  }
  await closeServer(embeddingUpstream);
}

const transcriptionUpstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert(raw.includes('name="model"'));
  assert(raw.includes('upstream-transcription-model'));
  assert(!raw.includes('synthetic-transcription'));
  assert(raw.includes('name="file"'));
  assert(raw.includes('synthetic audio'));
  res.writeHead(200, {
    'content-type': 'application/json'
  });
  res.end(
    JSON.stringify({
      text: 'synthetic transcript'
    })
  );
});

const transcriptionListened = await tryListen(transcriptionUpstream);
if (transcriptionListened) {
  const transcriptionPort = transcriptionUpstream.address().port;
  const transcriptionConfig = structuredClone(config);
  transcriptionConfig.server = {
    host: '127.0.0.1',
    port: 0
  };
  transcriptionConfig.defaults.transcriptionModel = 'synthetic-transcription';
  transcriptionConfig.backends['synthetic-transcription'] = {
    type: 'openai',
    baseUrl: `http://127.0.0.1:${transcriptionPort}/v1`,
    apiKey: 'sk-test'
  };
  transcriptionConfig.models.push({
    id: 'synthetic-transcription',
    name: 'Synthetic Transcription',
    backend: 'synthetic-transcription',
    upstreamModel: 'upstream-transcription-model',
    kind: 'audio_transcription',
    input: ['audio'],
    output: ['text'],
    capabilities: ['audio-transcription'],
    advertise: true
  });
  const transcriptionWrongKindModel = addSyntheticWrongKindChatModel(transcriptionConfig, 'synthetic-transcription');
  const transcriptionApp = createLloomServer(transcriptionConfig, {
    logger: { error() {} }
  });
  const transcriptionGatewayListened = await tryListen(transcriptionApp.server);
  if (transcriptionGatewayListened) {
    const { port } = transcriptionApp.server.address();
    try {
      const form = new FormData();
      form.set('model', 'synthetic-transcription');
      form.set('file', new Blob(['synthetic audio'], { type: 'audio/wav' }), 'sample.wav');
      const transcriptionResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form
      });
      assert.equal(transcriptionResponse.status, 200);
      const transcriptionJson = await transcriptionResponse.json();
      assert.equal(transcriptionJson.text, 'synthetic transcript');

      const defaultForm = new FormData();
      defaultForm.set('file', new Blob(['synthetic audio'], { type: 'audio/wav' }), 'sample.wav');
      const defaultResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: 'POST',
        body: defaultForm
      });
      assert.equal(defaultResponse.status, 200);
      assert.equal((await defaultResponse.json()).text, 'synthetic transcript');

      const wrongKindResponse = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: transcriptionWrongKindModel,
          file: 'ignored'
        })
      });
      assert.equal(wrongKindResponse.status, 400);
      const wrongKindJson = await wrongKindResponse.json();
      assert.equal(wrongKindJson.error.code, 'wrong_model_kind');
    } finally {
      await closeServer(transcriptionApp.server);
    }
  }
  await closeServer(transcriptionUpstream);
}

const mockUpstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const body = await readJsonBody(req);
  assert.equal(body.model, 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed');
  if (body.messages?.some((message) => message.content === 'abort-before-upstream-response')) {
    await wait(250);
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_abort',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'late'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4
        }
      })
    );
    return;
  }
  if (body.messages?.some((message) => message.content === 'usage aliases')) {
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'usage ok' }, finish_reason: 'stop' }]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            input_tokens: 29,
            output_tokens: 3,
            total_tokens: 32,
            input_tokens_details: {
              cached_tokens: 5
            }
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_usage_aliases',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'usage ok'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          input_tokens: 29,
          output_tokens: 3,
          total_tokens: 32,
          input_tokens_details: {
            cached_tokens: 5
          }
        }
      })
    );
    return;
  }
  if (body.max_tokens === 1) {
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 1,
            total_tokens: 9
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_incomplete',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'cut'
            },
            finish_reason: 'length'
          }
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 1,
          total_tokens: 9
        }
      })
    );
    return;
  }
  if (JSON.stringify(body.messages ?? []).includes('think please')) {
    assert(body.reasoning);
    const replayedThinking = body.messages?.find(
      (message) => message.role === 'assistant' && message.reasoning_content
    );
    if (replayedThinking) {
      assert.equal(replayedThinking.reasoning_content, 'prior thinking');
      assert.equal(replayedThinking.reasoning_signature, 'sig_prior');
      assert.equal(replayedThinking.content, 'prior answer');
    }
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: 'I should reason. ',
                reasoning_signature: 'sig_reason'
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: 'Then answer.'
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: 'done'
              },
              finish_reason: 'stop'
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 13,
            completion_tokens: 6,
            total_tokens: 19
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_reasoning',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: 'I should reason. Then answer.',
              reasoning_signature: 'sig_reason',
              content: 'done'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 6,
          total_tokens: 19
        }
      })
    );
    return;
  }
  if (body.messages?.some((message) => message.content === 'direct chat model rewrite')) {
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write(
        `event: message\ndata: ${JSON.stringify({
          id: 'chatcmpl_direct_stream',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ delta: { content: 'alias' }, finish_reason: 'stop' }]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl_direct_stream',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [],
          usage: {
            prompt_tokens: 23,
            completion_tokens: 1,
            total_tokens: 24
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_direct',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'alias'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 23,
          completion_tokens: 1,
          total_tokens: 24
        }
      })
    );
    return;
  }
  if (body.tools) {
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'get_weather');
    assert.equal(body.tools[0].function.parameters.type, 'object');
    assert.equal(body.tool_choice.type, 'function');
    assert.equal(body.tool_choice.function.name, 'get_weather');
    const delayedToolMetadata = JSON.stringify(body.messages ?? []).includes('delayed tool metadata');
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      if (delayedToolMetadata) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '{"city"'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'get_weather',
                        arguments: ':"Phoenix"}'
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 17,
              completion_tokens: 4,
              total_tokens: 21
            }
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_weather',
                    type: 'function',
                    function: {
                      name: 'get_weather',
                      arguments: '{"city"'
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: ':"Phoenix"}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 17,
            completion_tokens: 4,
            total_tokens: 21
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_tool',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Phoenix"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 4,
          total_tokens: 21
        }
      })
    );
    return;
  }
  if (body.messages?.some((message) => message.content === 'delayed stream content')) {
    assert.equal(body.stream, true);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache'
    });
    await wait(80);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'slow' }, finish_reason: 'stop' }]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6
        }
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  if (body.stream !== true) {
    assert(Array.isArray(body.messages));
    const toolResultMessage = body.messages.find((message) => message.role === 'tool');
    if (toolResultMessage) {
      const assistantToolMessage = body.messages.find((message) => message.role === 'assistant' && message.tool_calls);
      assert.equal(assistantToolMessage.tool_calls[0].id, 'call_weather');
      assert.equal(assistantToolMessage.tool_calls[0].function.name, 'get_weather');
      assert.equal(assistantToolMessage.tool_calls[0].function.arguments, '{"city":"Phoenix"}');
      assert.equal(toolResultMessage.tool_call_id, 'call_weather');
      assert.equal(toolResultMessage.content, 'sunny');
      res.writeHead(200, {
        'content-type': 'application/json'
      });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_tool_result',
          object: 'chat.completion',
          created: 1,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is sunny.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 4,
            total_tokens: 23
          }
        })
      );
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'hello'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 2,
          total_tokens: 9
        }
      })
    );
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache'
  });
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'hel' }, finish_reason: null }]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 2,
        total_tokens: 13
      }
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
});

const mockListened = await tryListen(mockUpstream);
if (mockListened) {
  const mockPort = mockUpstream.address().port;
  const streamConfig = structuredClone(config);
  streamConfig.server = {
    host: '127.0.0.1',
    port: 0
  };
  streamConfig.backends['mtplx-27b'] = {
    ...streamConfig.backends['mtplx-27b'],
    baseUrl: `http://127.0.0.1:${mockPort}/v1`
  };
  const streamDefaultModel = streamConfig.models.find(
    (model) => model.id === 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
  );
  assert(streamDefaultModel);
  delete streamDefaultModel.runtime;
  streamConfig.models.push({
    id: 'chat-alias-model',
    name: 'Chat Alias Model',
    backend: 'mtplx-27b',
    upstreamModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
    kind: 'chat',
    advertise: true
  });
  const streamApp = createLloomServer(streamConfig, {
    logger: {
      error() {}
    }
  });
  const streamListened = await tryListen(streamApp.server);
  if (streamListened) {
    const { port } = streamApp.server.address();
    try {
      const directChatResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'chat-alias-model',
          messages: [{ role: 'user', content: 'direct chat model rewrite' }]
        })
      });
      assert.equal(directChatResponse.status, 200);
      const directChatJson = await directChatResponse.json();
      assert.equal(directChatJson.model, 'chat-alias-model');
      assert.equal(directChatJson.usage.total_tokens, 24);

      const directChatStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'chat-alias-model',
          messages: [{ role: 'user', content: 'direct chat model rewrite' }],
          stream: true
        })
      });
      assert.equal(directChatStreamResponse.status, 200);
      const directChatStreamText = await directChatStreamResponse.text();
      assert(directChatStreamText.includes('"model":"chat-alias-model"'));
      assert(!directChatStreamText.includes('"model":"Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"'));
      assert(directChatStreamText.includes('"total_tokens":24'));

      const delayedChatStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          messages: [{ role: 'user', content: 'delayed stream content' }],
          stream: true,
          max_tokens: 8
        })
      });
      assert.equal(delayedChatStreamResponse.status, 200);
      const delayedChatStreamText = await delayedChatStreamResponse.text();
      assert(delayedChatStreamText.includes('"content":"slow"'));

      const responsesResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          instructions: 'Be terse.',
          input: 'say hello',
          max_output_tokens: 8
        })
      });
      assert.equal(responsesResponse.status, 200);
      const responsesJson = await responsesResponse.json();
      assert.equal(responsesJson.object, 'response');
      assert.equal(responsesJson.output_text, 'hello');
      assert.equal(responsesJson.usage.input_tokens, 7);
      assert.equal(responsesJson.usage.output_tokens, 2);

      const responsesStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'say hello'
                }
              ]
            }
          ],
          max_output_tokens: 8,
          stream: true
        })
      });
      assert.equal(responsesStreamResponse.status, 200);
      assert.match(responsesStreamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
      const responsesStreamText = await responsesStreamResponse.text();
      assert(responsesStreamText.includes('event: response.created'));
      assert(responsesStreamText.includes('event: response.output_text.delta'));
      assert(responsesStreamText.includes('"delta":"hel"'));
      assert(responsesStreamText.includes('"delta":"lo"'));
      assert(responsesStreamText.includes('event: response.completed'));
      assert(responsesStreamText.includes('"input_tokens":11'));
      assert(responsesStreamText.includes('"sequence_number":1'));

      const responsesIncompleteResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'please stop early',
          max_output_tokens: 1
        })
      });
      assert.equal(responsesIncompleteResponse.status, 200);
      const responsesIncompleteJson = await responsesIncompleteResponse.json();
      assert.equal(responsesIncompleteJson.status, 'incomplete');
      assert.equal(responsesIncompleteJson.incomplete_details.reason, 'max_output_tokens');
      assert.equal(responsesIncompleteJson.output_text, 'cut');

      const responsesIncompleteStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'please stop early',
          max_output_tokens: 1,
          stream: true
        })
      });
      assert.equal(responsesIncompleteStreamResponse.status, 200);
      const responsesIncompleteStreamText = await responsesIncompleteStreamResponse.text();
      assert(responsesIncompleteStreamText.includes('event: response.incomplete'));
      assert(responsesIncompleteStreamText.includes('"status":"incomplete"'));
      assert(responsesIncompleteStreamText.includes('"reason":"max_output_tokens"'));
      assert(responsesIncompleteStreamText.includes('"sequence_number":'));

      const responsesReasoningResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'think please',
          max_output_tokens: 32,
          reasoning: {
            effort: 'low',
            summary: 'auto'
          }
        })
      });
      assert.equal(responsesReasoningResponse.status, 200);
      const responsesReasoningJson = await responsesReasoningResponse.json();
      assert.equal(responsesReasoningJson.output[0].type, 'reasoning');
      assert.equal(responsesReasoningJson.output[0].content[0].text, 'I should reason. Then answer.');
      assert.equal(responsesReasoningJson.output[1].content[0].text, 'done');
      assert.equal(responsesReasoningJson.output_text, 'done');

      const responsesReasoningStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'think please',
          max_output_tokens: 32,
          reasoning: {
            effort: 'low'
          },
          stream: true
        })
      });
      assert.equal(responsesReasoningStreamResponse.status, 200);
      const responsesReasoningStreamText = await responsesReasoningStreamResponse.text();
      assert(responsesReasoningStreamText.includes('event: response.reasoning_text.delta'));
      assert(responsesReasoningStreamText.includes('"delta":"I should reason. "'));
      assert(responsesReasoningStreamText.includes('"delta":"Then answer."'));
      assert(responsesReasoningStreamText.includes('event: response.reasoning_text.done'));
      assert(responsesReasoningStreamText.includes('"type":"reasoning"'));
      assert(responsesReasoningStreamText.includes('"text":"I should reason. Then answer."'));
      assert(responsesReasoningStreamText.includes('"output_text":"done"'));

      const responsesToolResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'weather please',
          max_output_tokens: 32,
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get local weather.',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                },
                required: ['city']
              }
            }
          ],
          tool_choice: {
            type: 'function',
            name: 'get_weather'
          }
        })
      });
      assert.equal(responsesToolResponse.status, 200);
      const responsesToolJson = await responsesToolResponse.json();
      assert.equal(responsesToolJson.output_text, '');
      assert.deepEqual(responsesToolJson.output, [
        {
          id: 'call_weather',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_weather',
          name: 'get_weather',
          arguments: '{"city":"Phoenix"}'
        }
      ]);
      assert.equal(responsesToolJson.usage.input_tokens, 17);

      const responsesToolResultResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: [
            {
              type: 'function_call',
              call_id: 'call_weather',
              name: 'get_weather',
              arguments: '{"city":"Phoenix"}'
            },
            {
              type: 'function_call_output',
              call_id: 'call_weather',
              output: 'sunny'
            }
          ],
          max_output_tokens: 32
        })
      });
      assert.equal(responsesToolResultResponse.status, 200);
      const responsesToolResultJson = await responsesToolResultResponse.json();
      assert.equal(responsesToolResultJson.output_text, 'It is sunny.');
      assert.equal(responsesToolResultJson.usage.input_tokens, 19);

      const responsesToolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'weather please',
          max_output_tokens: 32,
          stream: true,
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          ],
          tool_choice: {
            type: 'function',
            name: 'get_weather'
          }
        })
      });
      assert.equal(responsesToolStreamResponse.status, 200);
      assert.match(responsesToolStreamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
      const responsesToolStreamText = await responsesToolStreamResponse.text();
      assert(responsesToolStreamText.includes('event: response.output_item.added'));
      assert(responsesToolStreamText.includes('"type":"function_call"'));
      assert(responsesToolStreamText.includes('"name":"get_weather"'));
      assert(responsesToolStreamText.includes('event: response.function_call_arguments.delta'));
      assert(responsesToolStreamText.includes('"delta":"{\\"city\\""'));
      assert(responsesToolStreamText.includes('"delta":":\\"Phoenix\\"}"'));
      assert(responsesToolStreamText.includes('event: response.function_call_arguments.done'));
      assert(responsesToolStreamText.includes('"arguments":"{\\"city\\":\\"Phoenix\\"}"'));
      assert(responsesToolStreamText.includes('"input_tokens":17'));

      const delayedResponsesToolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          input: 'delayed tool metadata',
          max_output_tokens: 32,
          stream: true,
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          ],
          tool_choice: {
            type: 'function',
            name: 'get_weather'
          }
        })
      });
      assert.equal(delayedResponsesToolStreamResponse.status, 200);
      const delayedResponsesToolStreamText = await delayedResponsesToolStreamResponse.text();
      assert(delayedResponsesToolStreamText.includes('event: response.output_item.added'));
      assert(delayedResponsesToolStreamText.includes('"name":"get_weather"'));
      assert(!delayedResponsesToolStreamText.includes('"name":""'));
      assert(delayedResponsesToolStreamText.includes('"delta":"{\\"city\\":\\"Phoenix\\"}"'));
      assert(delayedResponsesToolStreamText.includes('"arguments":"{\\"city\\":\\"Phoenix\\"}"'));

      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 8,
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'say hello'
            }
          ]
        })
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const streamText = await response.text();
      assert(streamText.includes('event: message_start'));
      assert(streamText.includes('event: content_block_delta'));
      assert(streamText.includes('"text":"hel"'));
      assert(streamText.includes('"text":"lo"'));
      assert(streamText.includes('"input_tokens":11'));
      assert(streamText.includes('event: message_stop'));

      const toolResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          tools: [
            {
              name: 'get_weather',
              description: 'Get local weather.',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                },
                required: ['city']
              }
            }
          ],
          tool_choice: {
            type: 'tool',
            name: 'get_weather'
          },
          messages: [
            {
              role: 'user',
              content: 'weather please'
            }
          ]
        })
      });
      assert.equal(toolResponse.status, 200);
      const toolJson = await toolResponse.json();
      assert.equal(toolJson.stop_reason, 'tool_use');
      assert.equal(toolJson.usage.input_tokens, 17);
      assert.equal(toolJson.usage.output_tokens, 4);
      assert.deepEqual(toolJson.content, [
        {
          type: 'tool_use',
          id: 'call_weather',
          name: 'get_weather',
          input: {
            city: 'Phoenix'
          }
        }
      ]);

      const toolResultResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call_weather',
                  name: 'get_weather',
                  input: {
                    city: 'Phoenix'
                  }
                }
              ]
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: 'sunny'
                }
              ]
            }
          ]
        })
      });
      assert.equal(toolResultResponse.status, 200);
      const toolResultJson = await toolResultResponse.json();
      assert.equal(toolResultJson.content[0].text, 'It is sunny.');
      assert.equal(toolResultJson.usage.input_tokens, 19);

      const usageAliasResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 8,
          messages: [
            {
              role: 'user',
              content: 'usage aliases'
            }
          ]
        })
      });
      assert.equal(usageAliasResponse.status, 200);
      const usageAliasJson = await usageAliasResponse.json();
      assert.equal(usageAliasJson.content[0].text, 'usage ok');
      assert.equal(usageAliasJson.usage.input_tokens, 29);
      assert.equal(usageAliasJson.usage.output_tokens, 3);
      assert.equal(usageAliasJson.usage.cache_read_input_tokens, 5);

      const thinkingResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          thinking: {
            type: 'enabled',
            budget_tokens: 1024
          },
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'prior thinking',
                  signature: 'sig_prior'
                },
                {
                  type: 'text',
                  text: 'prior answer'
                }
              ]
            },
            {
              role: 'user',
              content: 'think please'
            }
          ]
        })
      });
      assert.equal(thinkingResponse.status, 200);
      const thinkingJson = await thinkingResponse.json();
      assert.deepEqual(thinkingJson.content.slice(0, 2), [
        {
          type: 'thinking',
          thinking: 'I should reason. Then answer.',
          signature: 'sig_reason'
        },
        {
          type: 'text',
          text: 'done'
        }
      ]);

      const thinkingStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          thinking: {
            type: 'enabled',
            budget_tokens: 1024
          },
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'think please'
            }
          ]
        })
      });
      assert.equal(thinkingStreamResponse.status, 200);
      const thinkingStreamText = await thinkingStreamResponse.text();
      assert(thinkingStreamText.includes('"type":"thinking"'));
      assert(thinkingStreamText.includes('"type":"thinking_delta"'));
      assert(thinkingStreamText.includes('"thinking":"I should reason. "'));
      assert(thinkingStreamText.includes('"thinking":"Then answer."'));
      assert(thinkingStreamText.includes('"type":"signature_delta"'));
      assert(thinkingStreamText.includes('"signature":"sig_reason"'));
      assert(thinkingStreamText.includes('"type":"text_delta"'));
      assert(thinkingStreamText.includes('"text":"done"'));

      const usageAliasStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 8,
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'usage aliases'
            }
          ]
        })
      });
      assert.equal(usageAliasStreamResponse.status, 200);
      const usageAliasStreamText = await usageAliasStreamResponse.text();
      assert(usageAliasStreamText.includes('"text":"usage ok"'));
      assert(usageAliasStreamText.includes('"input_tokens":29'));
      assert(usageAliasStreamText.includes('"output_tokens":3'));
      assert(usageAliasStreamText.includes('"cache_read_input_tokens":5'));

      const toolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          stream: true,
          tools: [
            {
              name: 'get_weather',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          ],
          tool_choice: {
            type: 'tool',
            name: 'get_weather'
          },
          messages: [
            {
              role: 'user',
              content: 'weather please'
            }
          ]
        })
      });
      assert.equal(toolStreamResponse.status, 200);
      assert.match(toolStreamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
      const toolStreamText = await toolStreamResponse.text();
      assert(toolStreamText.includes('event: content_block_start'));
      assert(toolStreamText.includes('"type":"tool_use"'));
      assert(toolStreamText.includes('"name":"get_weather"'));
      assert(toolStreamText.includes('"type":"input_json_delta"'));
      assert(toolStreamText.includes('"partial_json":"{\\"city\\""'));
      assert(toolStreamText.includes('"partial_json":":\\"Phoenix\\"}"'));
      assert(toolStreamText.includes('"stop_reason":"tool_use"'));
      assert(toolStreamText.includes('"input_tokens":17'));

      const delayedToolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
          max_tokens: 32,
          stream: true,
          tools: [
            {
              name: 'get_weather',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          ],
          tool_choice: {
            type: 'tool',
            name: 'get_weather'
          },
          messages: [
            {
              role: 'user',
              content: 'delayed tool metadata'
            }
          ]
        })
      });
      assert.equal(delayedToolStreamResponse.status, 200);
      const delayedToolStreamText = await delayedToolStreamResponse.text();
      assert(delayedToolStreamText.includes('"type":"tool_use"'));
      assert(delayedToolStreamText.includes('"id":"call_weather"'));
      assert(delayedToolStreamText.includes('"name":"get_weather"'));
      assert(!delayedToolStreamText.includes('"name":"tool"'));
      assert(delayedToolStreamText.includes('"partial_json":"{\\"city\\":\\"Phoenix\\"}"'));
      assert(delayedToolStreamText.includes('"stop_reason":"tool_use"'));

      const abortBody = JSON.stringify({
        model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
        messages: [
          {
            role: 'user',
            content: 'abort-before-upstream-response'
          }
        ],
        max_tokens: 8
      });
      const abortRequest = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(abortBody)
        }
      });
      abortRequest.on('error', () => {});
      abortRequest.end(abortBody);
      await wait(25);
      abortRequest.destroy();
      await wait(350);

      const metricsResponse = await fetch(`http://127.0.0.1:${port}/gateway/metrics`);
      assert.equal(metricsResponse.status, 200);
      const metricsJson = await metricsResponse.json();
      assert(metricsJson.host?.memory?.totalBytes > 0);
      assert.equal(typeof metricsJson.host?.cpu?.logicalCpus, 'number');
      const modelMetrics = metricsJson.models.find(
        (model) => model.id === 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'
      );
      assert(modelMetrics);
      assert(modelMetrics.requests >= 9);
      assert(modelMetrics.inputTokens >= 135);
      assert(modelMetrics.outputTokens >= 26);
      assert(metricsJson.routes.some((route) => route.id === '/v1/responses' && route.requests >= 5));
      assert(metricsJson.routes.some((route) => route.id === '/v1/messages' && route.requests >= 4));
      assert(metricsJson.recent.some((entry) => entry.stream === true && entry.usage?.input_tokens === 17));
      assert(metricsJson.recent.some((entry) => entry.caller === 'node'));
      const delayedMetric = metricsJson.recent.find(
        (entry) =>
          entry.route === '/v1/chat/completions' &&
          entry.stream === true &&
          entry.usage?.input_tokens === 5 &&
          entry.usage?.output_tokens === 1
      );
      assert(delayedMetric);
      assert(delayedMetric.outputChars > 0);
      assert.equal(typeof delayedMetric.firstContentMs, 'number');
      assert.equal(typeof delayedMetric.lastContentMs, 'number');
      assert(delayedMetric.firstContentMs >= 40);
      assert(delayedMetric.lastContentMs >= delayedMetric.firstContentMs);
      assert(delayedMetric.durationMs >= delayedMetric.firstContentMs);
      assert(modelMetrics.firstContentCount > 0);
      assert.equal(typeof modelMetrics.avgFirstContentMs, 'number');
      assert(modelMetrics.maxFirstContentMs >= delayedMetric.firstContentMs);
      assert.equal(typeof modelMetrics.decodeTokensPerSecond, 'number');
      assert(modelMetrics.decodeSamples > 0);
      assert(modelMetrics.decodeTokens > 0);
      assert(modelMetrics.recentDecodeRates.length > 0);
      assert(modelMetrics.recentDecodeRates.length <= 10);
      assert.equal(typeof metricsJson.rolling.short.outputTokensPerSecond, 'number');
      assert.equal(metricsJson.rolling.short.windowMs, 10000);
      assert.equal(metricsJson.rolling.minute.windowMs, 60000);
      assert(
        metricsJson.recent.some(
          (entry) => entry.status === 499 && entry.error === 'client closed before upstream response completed'
        )
      );
      assert(metricsJson.routes.some((route) => route.id === '/v1/chat/completions' && route.last?.status === 499));

      const singleModelMetricsResponse = await fetch(
        `http://127.0.0.1:${port}/gateway/metrics?model=${encodeURIComponent('Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed')}`
      );
      assert.equal(singleModelMetricsResponse.status, 200);
      const singleModelMetricsJson = await singleModelMetricsResponse.json();
      assert.equal(singleModelMetricsJson.models.length, 1);
      assert.equal(singleModelMetricsJson.models[0].id, 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed');
    } finally {
      await closeServer(streamApp.server);
      await closeServer(mockUpstream);
    }
  } else {
    await closeServer(mockUpstream);
  }
}

console.log('smoke ok');
