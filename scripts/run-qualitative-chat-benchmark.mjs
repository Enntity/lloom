#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8100/v1';
const DEFAULT_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
  const flags = { model: [], case: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    if (key === 'model' || key === 'case') flags[key].push(value);
    else flags[key] = value;
    index += 1;
  }
  return flags;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function resolveGatewayApiKey(flags) {
  if (flags['api-key-env']) return process.env[flags['api-key-env']] || '';
  if (process.env.LLOOM_API_KEY) return process.env.LLOOM_API_KEY;
  if (!flags.config) return '';
  const config = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  const configured = Array.isArray(config.security?.apiKeys) ? config.security.apiKeys[0] : '';
  return typeof configured === 'string' && !configured.startsWith('${') ? configured : '';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

function inspectToolCall(testCase, message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (!testCase.expectedTool) return null;
  const call = calls[0];
  let parsedArguments = null;
  try {
    parsedArguments = JSON.parse(call?.function?.arguments ?? '');
  } catch {
    // Keep the raw arguments in the artifact; invalid JSON is a benchmark result.
  }
  return {
    callCount: calls.length,
    name: call?.function?.name ?? null,
    arguments: parsedArguments,
    validJson: parsedArguments != null,
    expectedName: testCase.expectedTool.name,
    expectedArguments: testCase.expectedTool.arguments,
    exactMatch:
      calls.length === 1 &&
      call?.function?.name === testCase.expectedTool.name &&
      JSON.stringify(canonicalJson(parsedArguments)) === JSON.stringify(canonicalJson(testCase.expectedTool.arguments))
  };
}

async function runCase({
  baseUrl,
  apiKey,
  model,
  suite,
  testCase,
  timeoutMs,
  maxTokensOverride,
  reasoningEffortOverride
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const request = {
    model,
    messages: [
      { role: 'system', content: testCase.system },
      { role: 'user', content: testCase.user }
    ],
    temperature: suite.defaults?.temperature ?? 0,
    seed: suite.defaults?.seed,
    max_tokens: maxTokensOverride ?? testCase.maxTokens ?? suite.defaults?.maxTokens ?? 900,
    reasoning: {
      effort: reasoningEffortOverride ?? testCase.reasoningEffort ?? suite.defaults?.reasoningEffort ?? 'low'
    },
    stream: false,
    ...(testCase.tools ? { tools: testCase.tools, tool_choice: testCase.toolChoice ?? 'auto' } : {})
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'x-lloom-client': 'LLooM-Qualitative-Benchmark'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Preserve non-JSON provider or gateway failures below.
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        caseId: testCase.id,
        title: testCase.title,
        ok: false,
        startedAt,
        elapsedMs,
        status: response.status,
        error: body ?? text.slice(0, 2000),
        rubric: testCase.rubric
      };
    }
    const message = body?.choices?.[0]?.message ?? null;
    return {
      caseId: testCase.id,
      title: testCase.title,
      ok: true,
      startedAt,
      elapsedMs,
      responseModel: body?.model ?? null,
      provider: body?.provider ?? null,
      finishReason: body?.choices?.[0]?.finish_reason ?? null,
      usage: body?.usage ?? null,
      message,
      toolAssessment: inspectToolCall(testCase, message),
      rubric: testCase.rubric
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      title: testCase.title,
      ok: false,
      startedAt,
      elapsedMs: Math.round(performance.now() - started),
      error: controller.signal.reason?.message ?? error?.message ?? String(error),
      rubric: testCase.rubric
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.suite) throw new Error('use --suite PATH');
  if (!flags.model.length)
    throw new Error('use --model MODEL_ID at least once; order defines the baseline and candidates');
  const suitePath = path.resolve(flags.suite);
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  if (!Array.isArray(suite.cases) || !suite.cases.length) throw new Error('suite.cases must be a non-empty array');
  const selectedCases = flags.case.length ? suite.cases.filter((entry) => flags.case.includes(entry.id)) : suite.cases;
  if (!selectedCases.length) throw new Error(`none of the requested cases exist: ${flags.case.join(', ')}`);
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  const apiKey = resolveGatewayApiKey(flags);
  const timeoutMs = positiveInteger(flags['timeout-ms'], DEFAULT_TIMEOUT_MS);
  const maxTokensOverride = flags['max-tokens'] ? positiveInteger(flags['max-tokens'], null) : null;
  const reasoningEffortOverride = flags['reasoning-effort'] || null;
  const artifact = {
    schemaVersion: 1,
    suite: {
      id: suite.id,
      title: suite.title,
      description: suite.description,
      source: path.relative(process.cwd(), suitePath) || path.basename(suitePath),
      synthetic: true
    },
    gateway: { baseUrl },
    run: {
      startedAt: new Date().toISOString(),
      modelOrder: flags.model,
      baselineModel: flags.model[0],
      settings: suite.defaults ?? {},
      overrides: {
        maxTokens: maxTokensOverride,
        reasoningEffort: reasoningEffortOverride
      },
      caseFilter: flags.case,
      timeoutMs
    },
    models: []
  };

  for (const model of flags.model) {
    const modelRun = { model, startedAt: new Date().toISOString(), cases: [] };
    for (const testCase of selectedCases) {
      process.stderr.write(`running ${model} :: ${testCase.id}\n`);
      modelRun.cases.push(
        await runCase({
          baseUrl,
          apiKey,
          model,
          suite,
          testCase,
          timeoutMs,
          maxTokensOverride,
          reasoningEffortOverride
        })
      );
    }
    modelRun.completedAt = new Date().toISOString();
    modelRun.ok = modelRun.cases.every((entry) => entry.ok);
    modelRun.totalElapsedMs = modelRun.cases.reduce((sum, entry) => sum + entry.elapsedMs, 0);
    modelRun.usage = modelRun.cases.reduce(
      (totals, entry) => ({
        promptTokens: totals.promptTokens + Number(entry.usage?.prompt_tokens ?? 0),
        completionTokens: totals.completionTokens + Number(entry.usage?.completion_tokens ?? 0),
        totalTokens: totals.totalTokens + Number(entry.usage?.total_tokens ?? 0)
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );
    artifact.models.push(modelRun);
  }

  artifact.run.completedAt = new Date().toISOString();
  artifact.ok = artifact.models.every((entry) => entry.ok);
  const output = `${JSON.stringify(artifact, null, 2)}\n`;
  if (flags.output) {
    const outputPath = path.resolve(flags.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
    process.stderr.write(`wrote ${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }
  if (!artifact.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error) }, null, 2));
  process.exitCode = 1;
});
