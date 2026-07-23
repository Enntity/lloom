#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../src/process-control.mjs';

const npmCache = path.join(os.tmpdir(), 'lloom-npm-cache');

const requiredFiles = [
  'LICENSE',
  'LICENSES/Apache-2.0.txt',
  'README.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'bin/lloom.mjs',
  'bin/lloom-host.mjs',
  'backends/catalog.json',
  'backends/mlx-audio/install.sh',
  'backends/mlx-audio/lloom_audio_server.py',
  'config/default.json',
  'assets/chat-templates/qwen3-xml-tool-reminder.jinja',
  'assets/chat-templates/qwen-fixed-v21.3.jinja',
  'src/server.mjs',
  'src/security.mjs',
  'src/protocol/index.mjs',
  'src/protocol/text.mjs',
  'src/protocol/reasoning-normalize.mjs',
  'src/protocol/responses.mjs',
  'src/protocol/anthropic.mjs',
  'src/protocol/sse.mjs',
  'src/protocol/stream-anthropic.mjs',
  'src/protocol/stream-responses.mjs',
  'src/host-server.mjs',
  'src/onboarding.mjs',
  'src/community-client.mjs',
  'src/tts-catalog.mjs',
  'src/voice-profiles.mjs',
  'scripts/check-interchange.mjs',
  'patches/apply_mtplx_longctx_fix.py',
  'patches/mtplx-attention_split-longctx.patch',
  'patches/mtplx-cache_state-longctx.patch',
  'patches/mtplx-longctx-gpu-watchdog.md',
  'community/recipes/index.json',
  'community/recipes/apple-silicon-qwen36-27b-mtplx.json',
  'community/recipes/apple-silicon-qwen36-35b-a3b-mtplx.json',
  'community/recipes/apple-silicon-qwen36-35b-a3b-optiq.json',
  'community/recipes/linux-nvidia-qwen36-27b-nvfp4-vllm.json',
  'community/recipes/linux-nvidia-qwen36-35b-a3b-fp8-vllm.json',
  'community/recipes/linux-nvidia-qwen36-27b-sglang.json',
  'community/benchmarks/apple-silicon-qwen36-m2max.json',
  'community/benchmarks/linux-nvidia-qwen36-vllm.json',
  'community/keys/README.md',
  'community/keys/lloom-dev-signing-public.pem',
  'schemas/machine-profile.v1.schema.json',
  'schemas/recipe-pack.v1.schema.json',
  'schemas/recommendation-response.v1.schema.json',
  'schemas/signing-keys.v1.schema.json',
  'examples/interchange/recommendation-response.v1.json',
  'examples/interchange/signing-keys.v1.json',
  'clients/examples/omp-models.yml'
];

const forbiddenPrefixes = ['.lloom/', 'clients/generated/', 'data/', 'logs/', 'node_modules/', 'test/'];
const forbiddenGeneratedFiles = [/(^|\/)__pycache__\//, /\.py[cod]$/i];

function parsePackJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('[');
    const end = stdout.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(stdout.slice(start, end + 1));
    }
    throw new Error(`npm pack did not return JSON:\n${stdout}`);
  }
}

function fail(message, details = []) {
  const suffix = details.length ? `\n${details.map((item) => `- ${item}`).join('\n')}` : '';
  throw new Error(`${message}${suffix}`);
}

function installedBin(prefix, name) {
  const command = process.platform === 'win32' ? `${name}.cmd` : name;
  return path.join(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'), command);
}

function tarballPath(packRoot, manifest) {
  if (!manifest?.filename) fail('npm pack output did not include a tarball filename');
  return path.join(packRoot, path.basename(manifest.filename));
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('failed to allocate a loopback port'));
        else resolve(port);
      });
    });
  });
}

async function fetchJson(url, timeoutMs = 1000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  // eslint-disable-next-line no-useless-assignment
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function waitForHostHealth(baseUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health?.ok) return health;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for installed lloom-host at ${baseUrl}: ${lastError?.message ?? 'no response'}`);
}

function startHost(command, port, env) {
  const child = spawn(command, ['serve', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    output() {
      return { stdout, stderr };
    }
  };
}

async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between the close check and fallback kill.
      }
    }, 2000).unref();
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

function assertRecommended(response, expectedPackId, label) {
  const actual = response?.recommendations?.[0]?.id;
  if (actual !== expectedPackId) {
    fail(`${label} selected the wrong recipe pack`, [`expected ${expectedPackId}`, `actual ${actual ?? '(none)'}`]);
  }
}

function commandEnv(overrides = {}) {
  const env = {
    ...process.env,
    ...overrides
  };
  delete env.LLOOM_CONFIG;
  return env;
}

function assertNotInstalled(report, expectedConfigPath, label) {
  if (report?.status !== 'not-installed') {
    fail(`${label} did not return a not-installed report`, [`actual status ${report?.status ?? '(none)'}`]);
  }
  if (report.config !== expectedConfigPath) {
    fail(`${label} reported the wrong install config path`, [
      `expected ${expectedConfigPath}`,
      `actual ${report.config ?? '(none)'}`
    ]);
  }
  if (!report.next?.applyAndStart?.includes('--go')) {
    fail(`${label} did not include the first-run apply/start command`);
  }
}

await fs.mkdir(npmCache, { recursive: true });
await runCommand(process.execPath, [path.join(process.cwd(), 'scripts/check-interchange.mjs')]);
const pack = await runCommand('npm', ['--cache', npmCache, 'pack', '--dry-run', '--json'], {
  env: commandEnv({
    npm_config_cache: npmCache
  })
});
const [manifest] = parsePackJson(pack.stdout);
if (!manifest?.files) fail('npm pack output did not contain a file list');

const files = manifest.files.map((file) => file.path).sort();
const fileSet = new Set(files);
const missing = requiredFiles.filter((file) => !fileSet.has(file));
if (missing.length) fail('LLooM package is missing required install/runtime files', missing);

const forbidden = files.filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
if (forbidden.length) fail('LLooM package includes generated or local-only files', forbidden);

const generated = files.filter((file) => forbiddenGeneratedFiles.some((pattern) => pattern.test(file)));
if (generated.length) fail('LLooM package includes generated Python bytecode', generated);

const privateKeys = files.filter((file) => /private.*\.pem$/i.test(file));
if (privateKeys.length) fail('LLooM package must not include private key material', privateKeys);

const keyReadme = await fs.readFile(path.join(process.cwd(), 'community/keys/README.md'), 'utf8');
if (!keyReadme.includes('Private keys are not packaged')) {
  fail('community/keys/README.md must state that private signing keys are not packaged');
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-package-'));
let hostProcess = null;
try {
  const packRoot = path.join(tempRoot, 'pack');
  const installRoot = path.join(tempRoot, 'prefix');
  const homeRoot = path.join(tempRoot, 'home');
  await fs.mkdir(packRoot, { recursive: true });
  await fs.mkdir(installRoot, { recursive: true });
  await fs.mkdir(homeRoot, { recursive: true });

  const packed = await runCommand('npm', ['--cache', npmCache, 'pack', '--json', '--pack-destination', packRoot], {
    env: commandEnv({
      npm_config_cache: npmCache
    })
  });
  const [packedManifest] = parsePackJson(packed.stdout);
  const tarball = tarballPath(packRoot, packedManifest);

  await runCommand('npm', ['--cache', npmCache, 'install', '--global', '--prefix', installRoot, tarball], {
    env: commandEnv({
      npm_config_cache: npmCache
    })
  });

  const lloom = installedBin(installRoot, 'lloom');
  const lloomHost = installedBin(installRoot, 'lloom-host');
  const lloomHelp = await runCommand(lloom, ['--help']);
  if (!lloomHelp.stdout.includes('lloom up') || !lloomHelp.stdout.includes('--go')) {
    fail('installed lloom --help did not include the first-run apply/start flow');
  }
  const hostHelp = await runCommand(lloomHost, ['--help']);
  if (!hostHelp.stdout.includes('lloom-host serve')) {
    fail('installed lloom-host --help did not include serve usage');
  }

  for (const commandArgs of [['models'], ['integrate', 'all'], ['runtimes']]) {
    const freshHome = path.join(tempRoot, `fresh-${commandArgs[0]}`);
    const result = await runCommand(lloom, [...commandArgs, '--home', freshHome, '--json'], {
      env: commandEnv({
        HOME: freshHome,
        LLOOM_HOME: path.join(freshHome, '.lloom')
      })
    });
    assertNotInstalled(
      JSON.parse(result.stdout),
      path.join(freshHome, '.lloom', 'config.json'),
      `installed lloom ${commandArgs.join(' ')}`
    );
  }

  const freshHumanHome = path.join(tempRoot, 'fresh-human-status');
  const humanMissingConfig = await runCommand(lloom, ['models', '--home', freshHumanHome], {
    env: commandEnv({
      HOME: freshHumanHome,
      LLOOM_HOME: path.join(freshHumanHome, '.lloom')
    })
  });
  if (!humanMissingConfig.stdout.includes('LLooM is not installed yet')) {
    fail('installed lloom missing-config output did not use the human formatter');
  }
  if (!humanMissingConfig.stdout.includes('lloom up') || !humanMissingConfig.stdout.includes('--go')) {
    fail('installed lloom missing-config output did not include first-run commands');
  }

  const previewHome = path.join(tempRoot, 'fresh-integrations-preview');
  const integrationsPreview = JSON.parse(
    (
      await runCommand(lloom, ['integrations', 'all', '--home', previewHome], {
        env: commandEnv({
          HOME: previewHome,
          LLOOM_HOME: path.join(previewHome, '.lloom')
        })
      })
    ).stdout
  );
  if (integrationsPreview.id !== 'lloom-client-integration-status' || integrationsPreview.summary?.total !== 13) {
    fail('installed lloom integrations did not remain a read-only preview command');
  }

  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  hostProcess = startHost(lloomHost, port, {
    ...commandEnv(),
    HOME: homeRoot,
    LLOOM_HOME: path.join(homeRoot, '.lloom')
  });
  const health = await waitForHostHealth(baseUrl);
  if (health?.data?.recipeCount !== 15 || health?.data?.benchmarkCount !== 12) {
    fail('installed lloom-host is not serving packaged seed community data', [JSON.stringify(health?.data ?? null)]);
  }

  const highMemoryRecommendation = await fetchJson(
    `${baseUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&gpu_vendor=apple&gpu_backend=metal&workload=agentic-coding&capability=tools&capability=reasoning&capability=long-context&limit=1`
  );
  assertRecommended(
    highMemoryRecommendation,
    'apple-silicon-qwen36-35b-a3b-mtplx-pack',
    'high-memory installed host recommendation'
  );

  const lowMemoryRecommendation = await fetchJson(
    `${baseUrl}/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=64&accelerator=apple-gpu&gpu_vendor=apple&gpu_backend=metal&workload=agentic-coding&capability=tools&capability=reasoning&capability=long-context&limit=1`
  );
  assertRecommended(
    lowMemoryRecommendation,
    'apple-silicon-qwen36-27b-mtplx-pack',
    'lower-memory installed host recommendation'
  );

  const cudaRecommendation = await fetchJson(
    `${baseUrl}/v1/recipe-packs/recommended?platform=linux-arm64&memory_gb=128&accelerator=cuda&accelerator=nvidia-gpu&gpu_vendor=nvidia&gpu_backend=cuda&workload=agentic-coding&capability=tools&capability=reasoning&capability=long-context&limit=1`
  );
  assertRecommended(
    cudaRecommendation,
    'linux-nvidia-qwen36-27b-nvfp4-vllm-pack',
    'CUDA installed host recommendation'
  );

  const onboardingProfileEnv = {};
  if (process.platform === 'linux') {
    const profileBin = path.join(tempRoot, 'profile-bin');
    const profileShim = path.join(tempRoot, 'profile-shim.cjs');
    await fs.mkdir(profileBin, { recursive: true });
    await fs.writeFile(path.join(profileBin, 'nvidia-smi'), '#!/bin/sh\nprintf "0, NVIDIA GB10, 131072, 12.1\\n"\n', {
      mode: 0o755
    });
    await fs.writeFile(profileShim, "const os = require('node:os');\nos.totalmem = () => 128 * 1024 ** 3;\n", 'utf8');
    onboardingProfileEnv.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${profileShim}`]
      .filter(Boolean)
      .join(' ');
    onboardingProfileEnv.PATH = `${profileBin}${path.delimiter}${process.env.PATH ?? ''}`;
  }
  const expectedOnboardingRecipe =
    process.platform === 'linux' ? 'linux-nvidia-qwen36-27b-nvfp4-vllm' : 'apple-silicon-qwen36-35b-a3b-mtplx';
  const expectedEvidence = process.platform === 'linux' ? 'Evidence: 98.1 tok/s' : 'Evidence: 68.58 tok/s';
  const onboard = await runCommand(
    lloom,
    ['onboard', '--home', homeRoot, '--host', baseUrl, '--no-auto-host', '--json'],
    {
      env: commandEnv({
        HOME: homeRoot,
        LLOOM_HOME: path.join(homeRoot, '.lloom'),
        ...onboardingProfileEnv
      })
    }
  );
  const onboardReport = JSON.parse(onboard.stdout);
  if (onboardReport?.source !== 'community') fail('installed lloom onboard did not use the community source');
  if (onboardReport?.selectedRecipe?.id !== expectedOnboardingRecipe) {
    fail('installed lloom onboard selected the wrong recipe', [
      `expected ${expectedOnboardingRecipe}`,
      `actual ${onboardReport?.selectedRecipe?.id ?? '(none)'}`
    ]);
  }
  const warmups = Object.values(onboardReport?.setup?.phases?.init?.config?.runtimes ?? {})
    .map((runtime) => runtime?.warmup)
    .filter(Boolean);
  if (!warmups.some((warmup) => warmup?.body?.max_tokens === 2)) {
    fail('installed lloom onboard did not materialize the runtime warmup request');
  }

  const humanOnboard = await runCommand(
    lloom,
    ['onboard', '--home', path.join(tempRoot, 'human-home'), '--host', baseUrl, '--no-auto-host'],
    {
      env: commandEnv({
        HOME: path.join(tempRoot, 'human-home'),
        LLOOM_HOME: path.join(tempRoot, 'human-home', '.lloom'),
        ...onboardingProfileEnv
      })
    }
  );
  if (!humanOnboard.stdout.includes('Why this model:')) {
    fail('installed lloom onboard human summary did not explain the recommendation');
  }
  if (!humanOnboard.stdout.includes(expectedEvidence)) {
    fail('installed lloom onboard human summary did not include benchmark evidence');
  }
  if (!humanOnboard.stdout.includes('verified signature')) {
    fail('installed lloom onboard human summary did not include verified signature status');
  }
} catch (error) {
  if (hostProcess) {
    const output = hostProcess.output();
    if (output.stdout || output.stderr) {
      error.message += `\nlloom-host stdout:\n${output.stdout}\nlloom-host stderr:\n${output.stderr}`;
    }
  }
  throw error;
} finally {
  if (hostProcess) await stopHost(hostProcess.child);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(
  `package ok: ${manifest.name} includes ${files.length} files, ${manifest.unpackedSize} unpacked bytes; install smoke passed`
);
