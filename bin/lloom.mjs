#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  benchmarkOverview,
  defaultBenchmarksRoot,
  loadBenchmarkEvidence,
  submitBenchmarkSuites,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence
} from '../src/benchmarks.mjs';
import { applyBootstrap, createBootstrapPlan } from '../src/bootstrap.mjs';
import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  createClientIntegrationStatus,
  selectIntegrationArtifacts
} from '../src/client-integrations.mjs';
import {
  applyCommunityRecommendations,
  benchmarkDocumentsFromCommunityPlan,
  createCommunityPlan,
  recipeDocumentsFromCommunityPlan,
  selectedRecipeIdFromCommunityPlan
} from '../src/community-client.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDoctorReport } from '../src/doctor.mjs';
import { applyInit, defaultUserConfigPath } from '../src/init.mjs';
import { applyBackend, applyRecipe } from '../src/installer.mjs';
import { createInterchangeRegistry, createInterchangeValidationReport } from '../src/interchange.mjs';
import { profileMachine, rankRecipes } from '../src/machine-profile.mjs';
import { applyModelImport, applyModelImportGo } from '../src/model-intake.mjs';
import { applyOnboarding, createOnboardingPlan } from '../src/onboarding.mjs';
import { writeRecipePackExport } from '../src/recipe-pack-export.mjs';
import { applyRecipePack, createRecipePackPlan, loadTrustedKeys, submitRecipePack } from '../src/recipe-pack.mjs';
import { buildRecipeIndexReport } from '../src/recipe-index.mjs';
import { createRegistry } from '../src/registry.mjs';
import { loadRecipeById, loadRecipes, planRecipe } from '../src/recipes.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { runCommand } from '../src/process-control.mjs';
import { applyRuntimePolicyPlan, createRuntimePolicyPlan } from '../src/runtime-policy.mjs';
import { createLloomServer } from '../src/server.mjs';
import { applySetup, createSetupPlan } from '../src/setup.mjs';
import { createSetupStatus } from '../src/setup-status.mjs';
import {
  defaultVoicesRoot,
  getVoiceProfile,
  installVoiceProfile,
  listVoiceProfiles,
  removeVoiceProfile
} from '../src/voice-profiles.mjs';

const __filename = fileURLToPath(import.meta.url);

/** Command tiers used for help + installed-config policy. Aliases resolve before dispatch. */
const COMMAND_REGISTRY = [
  { name: 'up', aliases: ['onboard'], tier: 'primary', needsInstalledConfig: false },
  { name: 'down', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'doctor', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'serve', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'models', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'integrate', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'integrations', aliases: [], tier: 'primary', needsInstalledConfig: true },
  { name: 'add-model', aliases: ['model-add'], tier: 'primary', needsInstalledConfig: true },
  { name: 'voices', aliases: ['voice-list'], tier: 'primary', needsInstalledConfig: false },
  { name: 'voice-install', aliases: ['install-voice'], tier: 'primary', needsInstalledConfig: false },
  { name: 'voice-show', aliases: [], tier: 'primary', needsInstalledConfig: false },
  { name: 'voice-remove', aliases: ['voice-rm'], tier: 'primary', needsInstalledConfig: false },
  { name: 'setup', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'init', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'bootstrap', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'setup-status', aliases: ['status'], tier: 'advanced', needsInstalledConfig: true },
  { name: 'backends', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'backend-plan', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'backend-install', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'runtimes', aliases: ['runtime-status'], tier: 'advanced', needsInstalledConfig: true },
  { name: 'runtime-plan', aliases: ['runtime-policy'], tier: 'advanced', needsInstalledConfig: true },
  { name: 'runtime-admit', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'runtime-start', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'runtime-warmup', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'runtime-stop', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'keep-warm', aliases: [], tier: 'advanced', needsInstalledConfig: true },
  { name: 'profile', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'recipes', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'recipe-index', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  // library is a distinct report shape (adds profile + selected); not an alias of recipe-index.
  { name: 'library', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'select', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'plan', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'install', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'community', aliases: ['community-plan'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'community-import', aliases: ['community-sync'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'recipe-export', aliases: ['pack-export'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'recipe-import', aliases: ['recipe-pack'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'recipe-submit', aliases: ['pack-submit'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'benchmarks', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'benchmark-submit', aliases: ['benchmarks-submit'], tier: 'advanced', needsInstalledConfig: false },
  { name: 'interchange', aliases: [], tier: 'advanced', needsInstalledConfig: false },
  { name: 'validate', aliases: [], tier: 'advanced', needsInstalledConfig: false }
];

const COMMAND_BY_TOKEN = new Map();
for (const entry of COMMAND_REGISTRY) {
  COMMAND_BY_TOKEN.set(entry.name, entry);
  for (const alias of entry.aliases) COMMAND_BY_TOKEN.set(alias, entry);
}

function resolveCommand(token) {
  if (!token || token.startsWith('-')) {
    return { name: 'up', entry: COMMAND_BY_TOKEN.get('up'), raw: token };
  }
  const entry = COMMAND_BY_TOKEN.get(token);
  if (!entry) return { name: token, entry: null, raw: token };
  return { name: entry.name, entry, raw: token };
}

function usage() {
  return `LLooM — local-first LLM gateway

Primary commands:
  lloom / lloom up                 Preview the best setup for this machine
  lloom up --go                    Install, integrate clients, and start the model
  lloom down                       Stop all managed model backends
  lloom doctor                     Readiness report (blockers, warnings, next actions)
  lloom serve                      Run the gateway (reads ~/.lloom/config.json)
  lloom models                     List gateway model IDs
  lloom integrate <client|all>     Write client configs (omp, opencode, codex, …)
  lloom add-model <ref>            Import an ad hoc model (dry-run; add --apply --yes)
  lloom voices                     List installed named voices (clone profiles)
  lloom voice-install <id>         Install a named voice from a reference clip

Also useful:
  lloom up --json                  Full machine-readable plan
  lloom help advanced              Full command catalog

Environment:
  LLOOM_CONFIG  Path to config JSON
`;
}

function advancedUsage() {
  return `LLooM advanced command catalog:

First run:
  lloom [--recipe id] [--host url] [--workload id] [--capability id] [--tag id] [--signing-keys-path path] [--no-trust-host-keys] [--no-auto-host] [--home path] [--model-root path] [--port n] [--backend-port-range a-b] [--client id|all] [--backend-catalog path] [--go|--apply --yes] [--start] [--json]
  lloom up|onboard [--recipe id] [--host url] [--workload id] [--capability id] [--tag id] [--signing-keys-path path] [--no-trust-host-keys] [--no-auto-host] [--home path] [--model-root path] [--port n] [--backend-port-range a-b] [--client id|all] [--backend-catalog path] [--go|--apply --yes] [--start] [--json]
  lloom setup [--recipe id] [--config-out path] [--home path] [--model-root path] [--client id|all] [--backend-catalog path] [--apply --yes] [--start]
  lloom doctor [--recipe id] [--model-root path] [--client id|all] [--no-runtimes]

Serving and discovery:
  lloom serve [--config path] [--host host] [--port port]
  lloom models
  lloom profile
  lloom library
  lloom setup-status [--recipe id] [--model-root path] [--client id|all] [--no-runtimes]

Backends and runtimes:
  lloom down
  lloom backends [backend-id|all]
  lloom backend-plan <backend-id>
  lloom backend-install <backend-id> [--apply --yes] [--step step-id]
  lloom runtimes [runtime-id|all]
  lloom runtime-plan <runtime-id>
  lloom runtime-admit <runtime-id> [--apply --yes]
  lloom runtime-start|runtime-warmup|runtime-stop <runtime-id>
  lloom keep-warm

Models and clients:
  lloom add-model <hf-url|repo-id|local-path|ollama:tag|lmstudio:id|openai:url#model> [--backend id] [--api-key-env NAME] [--keep-warm] [--default] [--go|--apply --yes]
  lloom integrations [client-id|all] [--home path] [--generated-root path]
  lloom integrate [client-id|all] [--home path] [--generated-root path] [--apply --yes]

Named voices (TTS clone profiles under ~/.lloom/voices/<id>):
  lloom voices
  lloom voice-show <id>
  lloom voice-install <id> --ref <audio> --ref-text <transcript> [--model id] [--name str] [--temperature n] [--apply --yes] [--force]
  lloom voice-remove <id> --yes
  # Then: POST /v1/audio/speech { "voice": "<id>", "input": "Hello" }

Recipes, community, and benchmarks:
  lloom recipes
  lloom recipe-index
  lloom plan <recipe-id>
  lloom install <recipe-id> [--apply --yes]
  lloom community [--host url] [--workload id] [--capability id] [--tag id]
  lloom community-import [--host url] [--workload id] [--capability id] [--tag id] [--apply --yes]
  lloom recipe-export <recipe-id|all> [--output path] [--apply --yes]
  lloom recipe-import <pack-file-or-url> [--apply --yes]
  lloom recipe-submit <pack-file-or-url> [--host url] [--apply --yes]
  lloom benchmarks [recipe-id|all]
  lloom benchmark-submit <benchmark-suite-file-or-url> [--host url] [--apply --yes]

Interchange:
  lloom interchange registry
  lloom interchange validate <file-or-url>
  lloom validate <file-or-url>
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function wantsJson(args) {
  return hasFlag(args, '--json') || argValue(args, '--format') === 'json';
}

function wantsGo(args) {
  return hasFlag(args, '--go');
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandLine(command, parts = []) {
  return [command, ...parts.filter(Boolean)].join(' ');
}

const INSTALLED_CONFIG_COMMANDS = new Set([
  'add-model',
  'bootstrap',
  'doctor',
  'down',
  'integrate',
  'integrations',
  'keep-warm',
  'model-add',
  'models',
  'runtime-admit',
  'runtime-plan',
  'runtime-policy',
  'runtime-start',
  'runtime-status',
  'runtime-stop',
  'runtime-warmup',
  'runtimes',
  'serve',
  'setup',
  'setup-status',
  'status'
]);

const OPERATIONAL_CONFIG_COMMANDS = new Set([
  'add-model',
  'doctor',
  'down',
  'integrate',
  'keep-warm',
  'model-add',
  'models',
  'runtime-admit',
  'runtime-plan',
  'runtime-policy',
  'runtime-start',
  'runtime-status',
  'runtime-stop',
  'runtime-warmup',
  'runtimes',
  'serve',
  'setup-status',
  'status'
]);

function installedConfigPath(args, command) {
  const explicit = argValue(args, '--config') ?? process.env.LLOOM_CONFIG;
  if (explicit) return explicit;
  if (!INSTALLED_CONFIG_COMMANDS.has(command)) return undefined;

  const home = argValue(args, '--home') ?? process.env.HOME;
  const userConfigPath = defaultUserConfigPath(home);
  return existsSync(userConfigPath) ? userConfigPath : undefined;
}

function missingInstalledConfig(args, command) {
  if (!OPERATIONAL_CONFIG_COMMANDS.has(command)) return null;
  const explicit = argValue(args, '--config') ?? process.env.LLOOM_CONFIG;
  if (explicit) return null;
  const home = argValue(args, '--home') ?? process.env.HOME;
  const configPath = defaultUserConfigPath(home);
  if (existsSync(configPath)) return null;
  const homeArg = argValue(args, '--home') ? `--home ${shellArg(home)}` : null;
  return {
    home,
    configPath,
    planCommand: commandLine('lloom up', [homeArg]),
    applyCommand: commandLine('lloom up', [homeArg, '--go'])
  };
}

function missingInstalledConfigReport({ home, configPath, planCommand, applyCommand }) {
  const action = {
    phase: 'install',
    id: 'run-onboarding',
    label: 'Preview the recommended LLooM setup',
    command: planCommand
  };
  const applyAction = {
    phase: 'install',
    id: 'apply-onboarding',
    label: 'Install, configure, integrate, and warm LLooM',
    command: applyCommand
  };
  return {
    ok: false,
    complete: false,
    status: 'not-installed',
    generatedAt: new Date().toISOString(),
    config: configPath,
    home,
    summary: {
      blockers: 1,
      warnings: 0,
      actions: 2,
      phasesReady: 0,
      phasesTotal: 1
    },
    blockers: [
      {
        phase: 'install',
        message: `No installed LLooM config found at ${configPath}`
      }
    ],
    warnings: [],
    actions: [action, applyAction],
    phases: [
      {
        id: 'install',
        title: 'LLooM Install',
        status: 'action-needed',
        ready: false,
        summary: `No installed config at ${configPath}; run onboarding first`,
        blockers: [`No installed LLooM config found at ${configPath}`],
        warnings: [],
        actions: [action, applyAction],
        details: {
          home,
          configPath
        }
      }
    ],
    next: {
      plan: planCommand,
      applyAndStart: applyCommand
    },
    details: {
      setupStatus: null,
      setupError: null,
      benchmarks: null
    }
  };
}

function reportStatus(report) {
  if (report.status) return report.status;
  if (report.complete === true) return 'complete';
  if (report.ok === true) return 'ready';
  return 'action-needed';
}

function reportCommandLabel(action) {
  const text = String(action?.label ?? action?.id ?? 'Action').trim();
  return text.replace(/\.$/, '');
}

function commandFlagValue(command, flag) {
  const pattern = new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:'([^']*)'|([^\\s]+))`);
  const match = String(command ?? '').match(pattern);
  return match?.[1] ?? match?.[2] ?? null;
}

function conciseCommand(command, { omitModelRoot = false, useGo = false } = {}) {
  if (!command) return null;
  const value = String(command);
  if (value.startsWith('lloom onboard ')) {
    const parts = ['lloom up'];
    const home = commandFlagValue(value, '--home');
    const modelRoot = commandFlagValue(value, '--model-root');
    if (home) parts.push('--home', shellArg(home));
    if (modelRoot && !omitModelRoot) parts.push('--model-root', shellArg(modelRoot));
    if (useGo && value.includes('--apply') && value.includes('--yes') && value.includes('--start')) {
      parts.push('--go');
    } else {
      parts.push('--apply', '--yes');
      if (value.includes('--start')) parts.push('--start');
    }
    return parts.join(' ');
  }
  if (value.startsWith('lloom setup ')) return 'lloom setup --apply --yes';
  return value;
}

function primaryStatusAction(report, actions) {
  if (report.complete) {
    return report.next?.serve
      ? {
          label: 'Start the local gateway',
          command: report.next.serve
        }
      : null;
  }
  if (report.status === 'not-installed') {
    return (
      actions.find((action) => action.id === 'apply-onboarding') ??
      (report.next?.applyAndStart
        ? {
            label: 'Install and start LLooM',
            command: report.next.applyAndStart
          }
        : null) ??
      actions[0] ??
      null
    );
  }
  const blockerAction = actions.find((action) => action.phase === 'backend' || action.phase === 'models');
  if (blockerAction) return blockerAction;
  const clientAction = actions.find((action) => action.phase === 'clients');
  if (clientAction) return clientAction;
  return actions[0] ?? null;
}

function formatStatusReport(report, { title = 'LLooM status' } = {}) {
  const lines = [title];
  lines.push(`Status: ${reportStatus(report)}`);
  if (report.config) lines.push(`Config: ${report.config}`);
  if (report.home) lines.push(`Home: ${report.home}`);
  if (report.selectedRecipe?.id) {
    lines.push(
      `Recipe: ${report.selectedRecipe.id}${report.selectedRecipe.name ? ` - ${report.selectedRecipe.name}` : ''}`
    );
  }
  if (report.summary) {
    const summary = [
      `${report.summary.blockers ?? 0} blocker(s)`,
      `${report.summary.warnings ?? 0} warning(s)`,
      `${report.summary.actions ?? 0} action(s)`,
      `${report.summary.phasesReady ?? 0}/${report.summary.phasesTotal ?? 0} phase(s) ready`
    ];
    lines.push(`Summary: ${summary.join(', ')}`);
  }

  const phases = Array.isArray(report.phases) ? report.phases : [];
  if (phases.length) {
    lines.push('');
    lines.push('Phases:');
    for (const current of phases) {
      lines.push(
        `  ${current.title ?? current.id}: ${current.status}${current.summary ? ` - ${current.summary}` : ''}`
      );
    }
  }

  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  if (blockers.length) {
    lines.push('');
    lines.push('Blockers:');
    for (const blocker of blockers.slice(0, 5)) {
      const phase = blocker.phase ? `${blocker.phase}: ` : '';
      lines.push(`  ${phase}${blocker.message ?? blocker}`);
    }
    if (blockers.length > 5) lines.push(`  ... ${blockers.length - 5} more`);
  }

  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of warnings.slice(0, 5)) {
      const phase = warning.phase ? `${warning.phase}: ` : '';
      lines.push(`  ${phase}${warning.message ?? warning}`);
    }
    if (warnings.length > 5) lines.push(`  ... ${warnings.length - 5} more`);
  }

  const actions = Array.isArray(report.actions) ? report.actions.filter((action) => action?.command) : [];
  const primary = primaryStatusAction(report, actions);
  if (primary || report.next) {
    lines.push('');
    lines.push('Next:');
    if (primary) {
      lines.push(`  ${reportCommandLabel(primary)}: ${conciseCommand(primary.command)}`);
    } else if (report.next?.applyAndStart) {
      lines.push(`  Install and start: ${conciseCommand(report.next.applyAndStart)}`);
    } else if (report.next?.plan) {
      lines.push(`  Preview: ${conciseCommand(report.next.plan)}`);
    } else {
      lines.push('  No required action.');
    }
  }
  lines.push('  Details: rerun with --json');
  return lines.join('\n');
}

function stageById(report, id) {
  return report.stages?.find((stage) => stage.id === id) ?? null;
}

function machineSummary(report) {
  const profile = report.community?.profile ?? report.setup?.phases?.init?.profile ?? report.doctor?.profile;
  if (!profile) return null;
  return [profile.platformId, profile.cpuBrand, profile.totalMemoryGb != null ? `${profile.totalMemoryGb} GB` : null]
    .filter(Boolean)
    .join(', ');
}

function stageReady(report, id) {
  return stageById(report, id)?.ready === true;
}

function firstCommunityPlan(report) {
  return Array.isArray(report.community?.plans) ? report.community.plans[0] : null;
}

function formatNumber(value, { maximumFractionDigits = 2 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits
  }).format(number);
}

function formatSignatureStatus(plan) {
  const signature = plan?.plan?.signature;
  if (!signature) return null;
  const keyIds = signature.signatures?.map((item) => item.keyId).filter(Boolean) ?? [];
  const suffix = keyIds.length ? ` (${keyIds.join(', ')})` : '';
  if (signature.trusted) return `trusted signature${suffix}`;
  if (signature.verified) return `verified signature${suffix}`;
  if (signature.signed) return `signed, not trusted${suffix}`;
  return signature.required ? 'signature required but missing' : null;
}

function formatBenchmarkLine(benchmark) {
  if (!benchmark) return null;
  const parts = [];
  const generation = formatNumber(benchmark.metrics?.generationTokPerSec);
  const prefill = formatNumber(benchmark.metrics?.prefillTokPerSec);
  const context = formatNumber(benchmark.metrics?.contextWindow, { maximumFractionDigits: 0 });
  if (generation) parts.push(`${generation} tok/s`);
  if (prefill) parts.push(`${prefill} tok/s prefill`);
  if (context) parts.push(`${context} context`);
  return parts.length ? parts.join(', ') : benchmark.id;
}

function recommendationEvidenceLines(report) {
  const plan = firstCommunityPlan(report);
  const recommendation = plan?.recommendation;
  if (!recommendation) return [];
  const lines = [];
  const summary = recommendation.summary ?? recommendation.evaluation?.name;
  if (summary) lines.push(`Why this model: ${summary}`);
  const evidence = formatBenchmarkLine(recommendation.benchmark);
  const signing =
    formatSignatureStatus(plan) ??
    (report.community?.host?.signingKeys?.status ? `signing keys ${report.community.host.signingKeys.status}` : null);
  const evidenceParts = [evidence, signing].filter(Boolean);
  if (evidenceParts.length) lines.push(`Evidence: ${evidenceParts.join('; ')}`);
  return lines;
}

function selectedModelLine(report) {
  const recommendation = firstCommunityPlan(report)?.recommendation;
  return (
    recommendation?.benchmark?.gatewayModel ??
    recommendation?.benchmark?.model ??
    report.setup?.phases?.init?.config?.defaults?.chatModel ??
    report.doctor?.details?.setupStatus?.details?.defaultChatModel ??
    null
  );
}

function friendlyMissingLines(report) {
  const lines = [];
  const modelStage = stageById(report, 'models');
  const clientStage = stageById(report, 'clients');
  const backendStage = stageById(report, 'backend');
  const runtimeStage = stageById(report, 'runtimes');

  if (backendStage && backendStage.ready !== true) {
    lines.push(`Backend: ${backendStage.summary ?? 'needs setup'}`);
  }
  if (modelStage && modelStage.ready !== true) {
    const modelRoot = report.modelRoot ?? report.setup?.modelRoot;
    const suffix = modelRoot ? ` in ${modelRoot}` : '';
    lines.push(`Model files: missing${suffix}.`);
  }
  if (clientStage && clientStage.ready !== true) {
    lines.push(`Client configs: ${clientStage.summary ?? 'need updating'}.`);
  }
  if (runtimeStage && runtimeStage.ready === false) {
    lines.push(`Running model: ${runtimeStage.summary ?? 'not started'}.`);
  }
  if (modelRootDetected(report) && report.modelRoot) {
    lines.push(`Config: update runtime paths to use ${report.modelRoot}.`);
  }
  return lines;
}

function modelRootDetected(report) {
  return report.setup?.modelRootDetected === true || report.modelRootDetected === true;
}

function onboardingCommand(report, command) {
  return conciseCommand(command, {
    omitModelRoot: modelRootDetected(report),
    useGo: true
  });
}

function onboardingActionLabel(report, { start = false } = {}) {
  if (modelRootDetected(report)) return start ? 'Update config and start' : 'Update config';
  return start ? 'Install and start' : 'Install';
}

function onboardingActionDescription(report) {
  if (modelRootDetected(report)) {
    return 'This writes config and client settings using the detected model files, then starts LLooM.';
  }
  return 'This installs the missing model files if needed, writes client config, and starts LLooM.';
}

function gatewaySummaryLines(report) {
  const gateway = report.gateway;
  if (!gateway) return [];
  const status = gateway.status === 'already-running' ? 'already running' : gateway.status;
  const lines = [`Gateway: ${status} at ${gateway.url}/`];
  if (gateway.pid) lines.push(`Gateway pid: ${gateway.pid}`);
  if (gateway.logPath) lines.push(`Gateway log: ${gateway.logPath}`);
  if (gateway.warning) lines.push(`Gateway warning: ${gateway.warning}`);
  return lines;
}

function formatOnboardingSummary(report) {
  const lines = [];
  const ready =
    report.complete === true ||
    (!modelRootDetected(report) &&
      stageReady(report, 'backend') &&
      stageReady(report, 'models') &&
      stageReady(report, 'clients') &&
      report.configPath &&
      existsSync(report.configPath));
  lines.push(ready ? 'LLooM is ready' : 'LLooM found a recommended local model');
  const machine = machineSummary(report);
  if (machine) lines.push(`Detected machine: ${machine}`);
  if (report.configPath) lines.push(`Config file: ${report.configPath}`);
  if (modelRootDetected(report) && report.modelRoot) {
    lines.push(`Using existing model files: ${report.modelRoot}`);
  }
  const modelLine = selectedModelLine(report);
  if (modelLine) lines.push(`Recommended model: ${modelLine}`);
  lines.push(...recommendationEvidenceLines(report));

  if (ready) {
    lines.push('');
    lines.push('Everything needed for setup is already in place.');
    const gatewayLines = gatewaySummaryLines(report);
    if (gatewayLines.length) lines.push(...gatewayLines);
  } else {
    const missing = friendlyMissingLines(report);
    if (missing.length) {
      lines.push('');
      lines.push('What is missing:');
      for (const item of missing) lines.push(`  ${item}`);
      if (missing.some((item) => item.startsWith('Model files:'))) {
        lines.push('  If the model is already somewhere else, rerun with --model-root /path/to/models.');
      }
    }
  }

  lines.push('');
  lines.push('Next:');
  if (ready && report.gateway?.health?.ok) {
    lines.push(`  Open dashboard: ${report.gateway.url}/`);
    lines.push('  Open OMP; it will use the LLooM provider from ~/.omp/agent/config.yml.');
  } else if (ready) {
    lines.push(report.next?.serve ? `  Start gateway: ${report.next.serve}` : '  No setup actions remain.');
  } else {
    if (report.next?.applyAndStart) {
      lines.push(
        `  ${onboardingActionLabel(report, { start: true })}: ${onboardingCommand(report, report.next.applyAndStart)}`
      );
    } else if (report.next?.apply) {
      lines.push(`  ${onboardingActionLabel(report)}: ${onboardingCommand(report, report.next.apply)}`);
    }
    if (report.next?.applyAndStart || report.next?.apply) {
      lines.push(`  ${onboardingActionDescription(report)}`);
    }
  }
  lines.push('  Details: rerun with --json');
  return lines.join('\n');
}

function formatProgressEvent(event) {
  if (event?.event !== 'step-start') return null;
  const step = event.step ?? {};
  if (step.action === 'download-model') {
    return `Downloading model files: ${step.model} -> ${step.destination}`;
  }
  if (step.action === 'command') {
    return `Running setup step: ${step.title ?? step.id}`;
  }
  return `Running setup step: ${step.title ?? step.id ?? 'setup'}`;
}

function formatIntegrationResult(result, clientId) {
  const lines = [];
  lines.push(result.dryRun ? 'LLooM integration plan' : 'LLooM integration result');
  lines.push(`Client: ${clientId}`);
  const results = Array.isArray(result.results) ? result.results : [];
  const written = results.filter((item) => item.status === 'written');
  const planned = results.filter((item) => item.status === 'planned');
  const skipped = results.filter((item) => item.status === 'skipped' || item.status === 'current');
  const failed = results.filter((item) => item.status === 'failed');
  if (failed.length) lines.push(`Status: failed (${failed.length} failed)`);
  else if (result.dryRun) lines.push(`Status: planned (${planned.length || results.length} file(s))`);
  else
    lines.push(`Status: complete (${written.length} written${skipped.length ? `, ${skipped.length} unchanged` : ''})`);

  if (results.length) {
    lines.push('');
    lines.push(result.dryRun ? 'Would update:' : 'Updated:');
    for (const item of results) {
      const target = item.targetPath ?? item.generatedPath;
      lines.push(`  ${item.name ?? item.id}: ${item.status}${target ? ` - ${target}` : ''}`);
    }
  }

  if (result.dryRun) {
    lines.push('');
    lines.push(`Next: lloom integrate ${clientId} --apply --yes`);
  } else if (clientId === 'omp') {
    lines.push('');
    const homePrefix = process.env.HOME ? `${process.env.HOME}/` : null;
    const targetPaths = results.map((item) => item.targetPath).filter(Boolean);
    const nativeHome = homePrefix && targetPaths.every((target) => target.startsWith(homePrefix));
    lines.push(
      nativeHome
        ? 'Next: open OMP; it will use the LLooM provider from ~/.omp/agent/config.yml.'
        : 'Next: use the updated OMP config files shown above.'
    );
  }
  lines.push('Details: rerun with --json');
  return lines.join('\n');
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function positional(args) {
  return args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    const previous = args[index - 1];
    return !previous?.startsWith('--');
  });
}

async function loadBenchmarksForCli(args) {
  const root = argValue(args, '--benchmarks-root') ?? defaultBenchmarksRoot;
  const evidence = await loadBenchmarkEvidence(root);
  const validationErrors = validateBenchmarkEvidence(evidence);
  return {
    root,
    evidence,
    validationErrors
  };
}

function runtimeManagerForCli(config) {
  return new RuntimeManager(config, {
    captureOutput: false,
    logger: {
      error(message) {
        console.error(message);
      }
    }
  });
}

function backendVariablesForCli(args) {
  const variables = defaultBackendVariables(process.env);
  for (const [flag, key] of [
    ['--shim-dir', 'shimDir'],
    ['--backend-root', 'backendRoot'],
    ['--install-root', 'installRoot'],
    ['--repo-parent', 'repoParent'],
    ['--backend-model-root', 'modelRoot']
  ]) {
    const value = argValue(args, flag);
    if (value) variables[key] = value;
  }
  return variables;
}

function envWithShimDir(variables) {
  const shimDir = variables?.shimDir;
  if (!shimDir) return process.env;
  return {
    ...process.env,
    PATH: `${shimDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`
  };
}

async function installModelBackendForCli(plan, args) {
  if (!plan.additions.runtimeId) {
    return { ok: true, status: 'skipped', reason: 'unmanaged-model' };
  }
  const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
  const backend = getBackend(catalog, plan.inference.backend);
  if (!backend) return { ok: false, error: `Unknown backend ${plan.inference.backend}` };
  const variables = backendVariablesForCli(args);
  const result = await applyBackend(backend, {
    dryRun: false,
    yes: true,
    variables,
    env: envWithShimDir(variables)
  });
  const failed = result.results.filter((entry) => ['failed', 'manual-required'].includes(entry.status));
  return {
    ...result,
    ok: failed.length === 0,
    status: failed.length ? 'failed' : 'completed',
    ...(failed.length
      ? { error: failed.map((entry) => entry.stderr || entry.message || `${entry.id} failed`).join('\n') }
      : {})
  };
}

async function downloadModelForCli(plan, args) {
  if (!plan.download?.command) return { ok: true, status: 'skipped', reason: 'no-download' };
  const variables = backendVariablesForCli(args);
  const env = envWithShimDir(variables);
  if (plan.download.command[0] !== 'hf') {
    const [command, ...commandArgs] = plan.download.command;
    const result = await runCommand(command, commandArgs, { allowFailure: true, env, stdio: 'inherit' });
    return result.code === 0
      ? { ok: true, status: 'completed', command: plan.download.command }
      : { ok: false, status: 'failed', error: result.stderr || `${command} exited ${result.code}` };
  }
  const [, ...downloadArgs] = plan.download.command;
  const candidates = [
    process.env.LLOOM_HF_BIN,
    process.env.HF_HUB_CLI,
    plan.download.command[0],
    'hf',
    'huggingface-cli'
  ]
    .filter(Boolean)
    .filter((command, index, all) => all.indexOf(command) === index);
  let lastResult = null;
  for (const command of candidates) {
    const result = await runCommand(command, downloadArgs, { allowFailure: true, env, stdio: 'inherit' });
    if (result.code === 0) return { ok: true, status: 'completed', command: [command, ...downloadArgs] };
    lastResult = result;
    if (result.code != null) break;
  }
  return {
    ok: false,
    status: 'failed',
    error: lastResult?.stderr || `No Hugging Face download CLI found. Install huggingface_hub or set LLOOM_HF_BIN.`
  };
}

async function startModelRuntimeForCli(plan, nextConfig) {
  const manager = runtimeManagerForCli(nextConfig);
  const result = await manager.start(plan.additions.runtimeId, {
    force: true,
    warmup: true,
    reason: 'cli-add-model-go'
  });
  return {
    ...result,
    ok: result.healthy === true
  };
}

function requireRuntimeId(args, command) {
  const runtimeId = positional(args)[1];
  if (!runtimeId) {
    console.error(`Missing runtime id for ${command}`);
    console.error(usage());
    process.exitCode = 2;
    return null;
  }
  return runtimeId;
}

function applyServeOverrides(config, args) {
  const host = argValue(args, '--host');
  const port = argValue(args, '--port');
  if (host) config.server.host = host;
  if (port) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error('--port must be an integer from 1 to 65535');
    }
    config.server.port = parsed;
  }
}

function gatewayUrlFor(config) {
  const host = config.server?.host ?? '127.0.0.1';
  const port = config.server?.port ?? 8100;
  return `http://${host}:${port}`;
}

async function gatewayHealth(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${gatewayUrlFor(config)}/health`, {
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json().catch(() => ({ ok: true }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitGatewayHealth(config, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await gatewayHealth(config);
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function gatewayProcessPaths(configPath) {
  const root = path.dirname(configPath);
  return {
    root,
    logPath: path.join(root, 'lloom-gateway.log'),
    pidPath: path.join(root, 'lloom-gateway.pid')
  };
}

async function startGatewayBackground(configPath) {
  const gatewayConfig = await loadConfig(configPath);
  const url = gatewayUrlFor(gatewayConfig);
  const alreadyHealthy = await gatewayHealth(gatewayConfig);
  const paths = gatewayProcessPaths(configPath);
  if (alreadyHealthy?.ok) {
    return {
      status: 'already-running',
      url,
      health: alreadyHealthy,
      ...paths
    };
  }

  mkdirSync(paths.root, { recursive: true });
  const logFd = openSync(paths.logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [__filename, 'serve', '--config', configPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  writeFileSync(paths.pidPath, `${child.pid}\n`);
  const health = await waitGatewayHealth(gatewayConfig);
  if (!health?.ok) {
    return {
      status: 'starting',
      url,
      pid: child.pid,
      health: null,
      warning: `Gateway did not answer /health yet; check ${paths.logPath}`,
      ...paths
    };
  }
  return {
    status: 'started',
    url,
    pid: child.pid,
    health,
    ...paths
  };
}

async function communityCliOptions(args) {
  const requireSignature = hasFlag(args, '--require-signature')
    ? true
    : hasFlag(args, '--no-require-signature')
      ? false
      : undefined;
  const trustHostKeys = hasFlag(args, '--trust-host-keys')
    ? true
    : hasFlag(args, '--no-trust-host-keys')
      ? false
      : undefined;
  const autoStartLocalHost = hasFlag(args, '--auto-host') ? true : hasFlag(args, '--no-auto-host') ? false : undefined;
  const trustedKeySpecs = argValues(args, '--trusted-key');
  return {
    hostUrl: argValue(args, '--host'),
    recipeFeedPath: argValue(args, '--recipe-feed-path'),
    signingKeysPath: argValue(args, '--signing-keys-path'),
    indexPath: argValue(args, '--index'),
    recipesRoot: argValue(args, '--recipes-root'),
    benchmarksRoot: argValue(args, '--benchmarks-root'),
    backendCatalogPath: argValue(args, '--backend-catalog'),
    workloads: argValues(args, '--workload'),
    capabilities: argValues(args, '--capability'),
    tags: argValues(args, '--tag'),
    ...(trustedKeySpecs.length ? { trustedKeys: await loadTrustedKeys(trustedKeySpecs) } : {}),
    ...(requireSignature == null ? {} : { requireSignature }),
    ...(trustHostKeys == null ? {} : { trustHostKeys }),
    ...(autoStartLocalHost == null ? {} : { autoStartLocalHost }),
    ...(argValue(args, '--limit') ? { limit: Number(argValue(args, '--limit')) } : {})
  };
}

function defaultLloomHome(home = process.env.HOME) {
  return home ? path.join(home, '.lloom') : path.resolve('.lloom');
}

function communityCacheCliOptions(args, config, home = process.env.HOME) {
  const root = path.join(defaultLloomHome(home), 'community');
  const recipesRoot = argValue(args, '--recipes-root') ?? config.init?.recipesRoot ?? path.join(root, 'recipes');
  return {
    indexPath: argValue(args, '--index') ?? config.init?.indexPath ?? path.join(recipesRoot, 'index.json'),
    recipesRoot,
    benchmarksRoot: argValue(args, '--benchmarks-root') ?? config.init?.benchmarksRoot ?? path.join(root, 'benchmarks')
  };
}

async function communityStatusCliContext(config, args, { recipeId, home = process.env.HOME } = {}) {
  if (recipeId || hasFlag(args, '--offline')) return {};
  const hostUrl = argValue(args, '--host') ?? config.community?.hostUrl;
  if (!hostUrl) return {};
  const communityOptions = await communityCliOptions(args);
  const cacheOptions = communityCacheCliOptions(args, config, home);
  const plan = await createCommunityPlan(config, {
    ...communityOptions,
    ...cacheOptions,
    hostUrl
  });
  if (!plan.ok) {
    throw new Error(
      `Community recommendation failed validation:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
  return {
    communityPlan: plan,
    recipeId: selectedRecipeIdFromCommunityPlan(plan),
    recipeDocuments: recipeDocumentsFromCommunityPlan(plan),
    benchmarkDocuments: benchmarkDocumentsFromCommunityPlan(plan),
    recipesRoot: cacheOptions.recipesRoot,
    benchmarksRoot: cacheOptions.benchmarksRoot,
    backendCatalogPath: argValue(args, '--backend-catalog') ?? plan.backendCatalogPath
  };
}

async function firstRunCliOptions(args) {
  const community = await communityCliOptions(args);
  const home = argValue(args, '--home') ?? process.env.HOME;
  return {
    recipeId: argValue(args, '--recipe'),
    ...community,
    configPath: argValue(args, '--config-out') ?? defaultUserConfigPath(home),
    modelRoot: argValue(args, '--model-root'),
    gatewayPort: argValue(args, '--port'),
    backendPortRange: argValue(args, '--backend-port-range'),
    clientId: argValue(args, '--client') ?? 'all',
    statePath: argValue(args, '--state'),
    home,
    generatedRoot: argValue(args, '--generated-root'),
    benchmarksRoot: community.benchmarksRoot ?? argValue(args, '--benchmarks-root'),
    backendVariables: backendVariablesForCli(args),
    backendCatalogPath: argValue(args, '--backend-catalog'),
    offline: hasFlag(args, '--offline'),
    includeRuntimes: !hasFlag(args, '--no-runtimes'),
    start: hasFlag(args, '--start') || wantsGo(args),
    autoDetectModelRoot: !argValue(args, '--model-root')
  };
}

async function main() {
  const args = process.argv.slice(2);
  const firstArg = args[0];
  if (firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
    const helpPositionals = positional(args);
    const topic = firstArg === 'help' ? helpPositionals[1] : helpPositionals[0];
    console.log(topic === 'advanced' ? advancedUsage() : usage());
    return;
  }
  const resolved = resolveCommand(firstArg && !firstArg.startsWith('-') ? firstArg : 'up');
  const command = resolved.name;
  if (firstArg && !firstArg.startsWith('-') && !resolved.entry && firstArg !== 'help') {
    console.error(`Unknown command: ${firstArg}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const missingConfig = missingInstalledConfig(args, command);
  if (missingConfig) {
    const report = missingInstalledConfigReport(missingConfig);
    console.log(
      wantsJson(args)
        ? JSON.stringify(report, null, 2)
        : formatStatusReport(report, { title: 'LLooM is not installed yet' })
    );
    return;
  }
  const configPath = installedConfigPath(args, command);
  const config = await loadConfig(configPath);

  const handlers = {
    serve: async ({ args, config, command: _command }) => {
      applyServeOverrides(config, args);
      const app = createLloomServer(config);
      await app.listen();
      console.log(`LLooM listening on http://${config.server.host}:${config.server.port}`);
    },
    models: async ({ args: _args, config, command: _command }) => {
      const registry = createRegistry(config);
      console.log(JSON.stringify({ data: registry.openAIModels() }, null, 2));
    },
    backends: async ({ args, config: _config, command: _command }) => {
      const backendId = positional(args)[1] ?? 'all';
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      const errors = validateBackendCatalog(catalog);
      if (errors.length) {
        throw new Error(`Invalid backend catalog:\n${errors.map((error) => `- ${error}`).join('\n')}`);
      }
      const backends =
        backendId === 'all' ? catalog.backends : catalog.backends.filter((backend) => backend.id === backendId);
      if (!backends.length) throw new Error(`Unknown backend ${backendId}`);
      console.log(
        JSON.stringify(
          {
            data: backends.map((backend) => ({
              id: backend.id,
              name: backend.name,
              kind: backend.kind,
              platforms: backend.platforms,
              features: backend.features,
              commands: backend.commands,
              server: backend.server
            }))
          },
          null,
          2
        )
      );
    },
    'backend-plan': async ({ args, config: _config, command: _command }) => {
      const backendId = positional(args)[1];
      if (!backendId) {
        console.error('Missing backend id');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      const backend = getBackend(catalog, backendId);
      if (!backend) throw new Error(`Unknown backend ${backendId}`);
      console.log(
        JSON.stringify(
          await planBackend(backend, {
            variables: backendVariablesForCli(args),
            checkCommands: true
          }),
          null,
          2
        )
      );
    },
    'backend-install': async ({ args, config: _config, command: _command }) => {
      const backendId = positional(args)[1];
      if (!backendId) {
        console.error('Missing backend id');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      const backend = getBackend(catalog, backendId);
      if (!backend) throw new Error(`Unknown backend ${backendId}`);
      const statePath = argValue(args, '--state');
      const onlyStep = argValue(args, '--step');
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      console.log(
        JSON.stringify(
          await applyBackend(backend, {
            dryRun: !apply,
            yes,
            ...(statePath ? { statePath } : {}),
            ...(onlyStep ? { onlyStep } : {}),
            variables: backendVariablesForCli(args)
          }),
          null,
          2
        )
      );
    },
    onboard: async ({ args, config, command: _command }) => {
      const go = wantsGo(args);
      const apply = hasFlag(args, '--apply') || go;
      const yes = hasFlag(args, '--yes') || go;
      const options = await firstRunCliOptions(args);
      const humanApply = apply && !wantsJson(args);
      const report = apply
        ? await applyOnboarding(config, {
            ...options,
            dryRun: false,
            yes,
            ...(humanApply
              ? {
                  stdio: 'inherit',
                  onProgress(event) {
                    const line = formatProgressEvent(event);
                    if (line) console.error(line);
                  }
                }
              : {})
          })
        : await createOnboardingPlan(config, options);
      if (go && report.ok !== false && report.configPath) {
        report.gateway = await startGatewayBackground(report.configPath);
        if (report.gateway?.health?.ok) {
          report.complete = true;
        }
      }
      console.log(wantsJson(args) ? JSON.stringify(report, null, 2) : formatOnboardingSummary(report));
    },
    setup: async ({ args, config, command: _command }) => {
      const recipeId = argValue(args, '--recipe');
      const home = argValue(args, '--home') ?? process.env.HOME;
      const configOut = argValue(args, '--config-out') ?? defaultUserConfigPath(home);
      const modelRoot = argValue(args, '--model-root');
      const generatedRoot = argValue(args, '--generated-root');
      const gatewayPort = argValue(args, '--port');
      const backendPortRange = argValue(args, '--backend-port-range');
      const clientId = argValue(args, '--client') ?? 'all';
      const statePath = argValue(args, '--state');
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      const start = hasFlag(args, '--start');
      const additive = hasFlag(args, '--additive');
      const options = {
        recipeId,
        configPath: configOut,
        ...(modelRoot ? { modelRoot } : {}),
        ...(gatewayPort ? { gatewayPort } : {}),
        ...(backendPortRange ? { backendPortRange } : {}),
        clientId,
        home,
        ...(generatedRoot ? { generatedRoot } : {}),
        backendVariables: backendVariablesForCli(args),
        recipesRoot: argValue(args, '--recipes-root'),
        benchmarksRoot: argValue(args, '--benchmarks-root'),
        backendCatalogPath: argValue(args, '--backend-catalog'),
        ...(statePath ? { statePath } : {}),
        additive
      };
      console.log(
        JSON.stringify(
          apply
            ? await applySetup(config, {
                ...options,
                dryRun: false,
                yes,
                start
              })
            : await createSetupPlan(config, options),
          null,
          2
        )
      );
    },
    init: async ({ args, config, command: _command }) => {
      const recipeId = argValue(args, '--recipe');
      const home = argValue(args, '--home') ?? process.env.HOME;
      const configOut = argValue(args, '--config-out') ?? defaultUserConfigPath(home);
      const modelRoot = argValue(args, '--model-root');
      const generatedRoot = argValue(args, '--generated-root');
      const gatewayPort = argValue(args, '--port');
      const backendPortRange = argValue(args, '--backend-port-range');
      const clientId = argValue(args, '--client') ?? 'all';
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      const integrate = hasFlag(args, '--integrate');
      console.log(
        JSON.stringify(
          await applyInit(config, {
            recipeId,
            configPath: configOut,
            ...(modelRoot ? { modelRoot } : {}),
            ...(gatewayPort ? { gatewayPort } : {}),
            ...(backendPortRange ? { backendPortRange } : {}),
            clientId,
            home,
            ...(generatedRoot ? { generatedRoot } : {}),
            dryRun: !apply,
            yes,
            integrate,
            backendVariables: backendVariablesForCli(args),
            backendCatalogPath: argValue(args, '--backend-catalog')
          }),
          null,
          2
        )
      );
    },
    bootstrap: async ({ args, config, command: _command }) => {
      const recipeId = argValue(args, '--recipe');
      const modelRoot = argValue(args, '--model-root');
      const clientId = argValue(args, '--client') ?? 'all';
      const statePath = argValue(args, '--state');
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      if (!apply) {
        console.log(
          JSON.stringify(
            await createBootstrapPlan(config, {
              recipeId,
              modelRoot,
              clientId,
              backendVariables: backendVariablesForCli(args),
              benchmarksRoot: argValue(args, '--benchmarks-root'),
              backendCatalogPath: argValue(args, '--backend-catalog')
            }),
            null,
            2
          )
        );
        return;
      }
      console.log(
        JSON.stringify(
          await applyBootstrap(config, {
            recipeId,
            modelRoot,
            clientId,
            dryRun: false,
            yes,
            ...(statePath ? { statePath } : {}),
            backendVariables: backendVariablesForCli(args),
            backendCatalogPath: argValue(args, '--backend-catalog')
          }),
          null,
          2
        )
      );
    },
    'setup-status': async ({ args, config, command: _command }) => {
      const recipeId = argValue(args, '--recipe');
      const modelRoot = argValue(args, '--model-root');
      const clientId = argValue(args, '--client') ?? 'all';
      const statePath = argValue(args, '--state');
      const generatedRoot = argValue(args, '--generated-root');
      const home = argValue(args, '--home') ?? process.env.HOME;
      const communityContext = await communityStatusCliContext(config, args, { recipeId, home });
      const setupStatus = await createSetupStatus(config, {
        recipeId: communityContext.recipeId ?? recipeId,
        modelRoot,
        clientId,
        generatedRoot,
        home,
        includeRuntimes: !hasFlag(args, '--no-runtimes'),
        backendVariables: backendVariablesForCli(args),
        recipesRoot: communityContext.recipesRoot ?? argValue(args, '--recipes-root'),
        recipeDocuments: communityContext.recipeDocuments,
        backendCatalogPath: communityContext.backendCatalogPath ?? argValue(args, '--backend-catalog'),
        ...(statePath ? { statePath } : {})
      });
      if (communityContext.communityPlan) {
        setupStatus.community = {
          host: communityContext.communityPlan.host,
          recommendationCount: communityContext.communityPlan.recommendationCount,
          selectedCount: communityContext.communityPlan.selectedCount,
          selectedRecipeId: communityContext.recipeId
        };
      }
      console.log(JSON.stringify(setupStatus, null, 2));
    },
    benchmarks: async ({ args, config: _config, command: _command }) => {
      const recipeId = positional(args)[1] ?? 'all';
      const { root, evidence, validationErrors } = await loadBenchmarksForCli(args);
      if (recipeId === 'all') {
        console.log(
          JSON.stringify(
            {
              ok: validationErrors.length === 0,
              root,
              count: evidence.length,
              validationErrors,
              data: benchmarkOverview(evidence)
            },
            null,
            2
          )
        );
        return;
      }
      const recipe = await loadRecipeById(recipeId, argValue(args, '--recipes-root'));
      console.log(
        JSON.stringify(
          {
            ok: validationErrors.length === 0,
            root,
            recipeId: recipe.id,
            count: evidence.filter((result) => result.recipeId === recipe.id).length,
            validationErrors,
            data: summarizeBenchmarksForRecipe(recipe, evidence)
          },
          null,
          2
        )
      );
    },
    'benchmark-submit': async ({ args, config, command: _command }) => {
      const source = positional(args)[1];
      if (!source) {
        console.error('Missing benchmark suite source');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const timeoutMs = argValue(args, '--timeout-ms');
      console.log(
        JSON.stringify(
          await submitBenchmarkSuites(source, config, {
            hostUrl: argValue(args, '--host'),
            submissionPath: argValue(args, '--submission-path'),
            ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
            dryRun: !hasFlag(args, '--apply'),
            yes: hasFlag(args, '--yes')
          }),
          null,
          2
        )
      );
    },
    profile: async ({ args, config: _config, command: _command }) => {
      const profile = await profileMachine();
      const recipes = await loadRecipes();
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      console.log(
        JSON.stringify(
          {
            profile,
            recipes: await rankRecipes(recipes, profile, { checkCommands: true }),
            backends: await planBackendCatalog(catalog, {
              checkCommands: true,
              variables: backendVariablesForCli(args)
            })
          },
          null,
          2
        )
      );
    },
    recipes: async ({ args: _args, config: _config, command: _command }) => {
      const recipes = await loadRecipes();
      console.log(
        JSON.stringify(
          {
            data: recipes.map((recipe) => ({
              id: recipe.id,
              name: recipe.name,
              version: recipe.version ?? 1,
              backend: recipe.backend,
              requirements: recipe.requirements,
              models: (recipe.models ?? []).map((model) => ({
                role: model.role,
                model: model.model,
                gatewayModel: model.gatewayModel,
                runtime: model.runtime
              }))
            }))
          },
          null,
          2
        )
      );
    },
    'recipe-index': async ({ args, config, command }) => {
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      const {
        evidence: benchmarkEvidence,
        validationErrors: benchmarkValidationErrors,
        root: benchmarksRoot
      } = await loadBenchmarksForCli(args);
      const report = await buildRecipeIndexReport(config, {
        indexPath: argValue(args, '--index'),
        recipesRoot: argValue(args, '--recipes-root'),
        modelRoot: argValue(args, '--model-root') ?? '${LLOOM_MODEL_ROOT}',
        backendIds: backendIds(catalog),
        benchmarksRoot,
        benchmarkEvidence,
        benchmarkValidationErrors
      });
      if (command === 'recipe-index') {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const profile = await profileMachine();
      const recipes = await loadRecipes(argValue(args, '--recipes-root'));
      const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
      console.log(
        JSON.stringify(
          {
            ...report,
            profile,
            selected: ranked.find((candidate) => candidate.selectable) ?? null,
            candidates: ranked
          },
          null,
          2
        )
      );
    },
    community: async ({ args, config, command: _command }) => {
      console.log(JSON.stringify(await createCommunityPlan(config, await communityCliOptions(args)), null, 2));
    },
    'community-import': async ({ args, config, command: _command }) => {
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      console.log(
        JSON.stringify(
          await applyCommunityRecommendations(config, {
            ...(await communityCliOptions(args)),
            dryRun: !apply,
            yes
          }),
          null,
          2
        )
      );
    },
    interchange: async ({ args, config, command }) => {
      const source = command === 'interchange' ? positional(args)[2] : positional(args)[1];
      const action = command === 'interchange' ? positional(args)[1] : 'validate';
      if (command === 'interchange' && action === 'registry') {
        console.log(
          JSON.stringify(
            createInterchangeRegistry({
              baseUrl: argValue(args, '--base-url') ?? 'https://lloom.dev'
            }),
            null,
            2
          )
        );
        return;
      }
      if (action !== 'validate' || !source) {
        console.error('Usage: lloom interchange <registry|validate> [file-or-url]');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      console.log(
        JSON.stringify(
          await createInterchangeValidationReport(source, config, {
            indexPath: argValue(args, '--index'),
            recipesRoot: argValue(args, '--recipes-root'),
            benchmarksRoot: argValue(args, '--benchmarks-root'),
            trustedKeys: await loadTrustedKeys(argValues(args, '--trusted-key')),
            requireSignature: hasFlag(args, '--require-signature')
          }),
          null,
          2
        )
      );
    },
    'recipe-export': async ({ args, config, command: _command }) => {
      const recipeIds = positional(args).slice(1);
      if (!recipeIds.length) {
        console.error('Missing recipe id for recipe-export');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      console.log(
        JSON.stringify(
          await writeRecipePackExport(config, {
            recipeIds,
            indexPath: argValue(args, '--index'),
            recipesRoot: argValue(args, '--recipes-root'),
            benchmarksRoot: argValue(args, '--benchmarks-root'),
            id: argValue(args, '--id'),
            name: argValue(args, '--name'),
            publisher: argValue(args, '--publisher'),
            includeBenchmarks: !hasFlag(args, '--no-benchmarks'),
            keyId: argValue(args, '--key-id'),
            privateKeyPath: argValue(args, '--private-key'),
            publicKeyPath: argValue(args, '--public-key'),
            outputPath: argValue(args, '--output'),
            dryRun: !apply,
            yes
          }),
          null,
          2
        )
      );
    },
    'recipe-import': async ({ args, config, command: _command }) => {
      const source = positional(args)[1];
      if (!source) {
        console.error('Missing recipe pack source');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      const trustedKeys = await loadTrustedKeys(argValues(args, '--trusted-key'));
      const options = {
        indexPath: argValue(args, '--index'),
        recipesRoot: argValue(args, '--recipes-root'),
        benchmarksRoot: argValue(args, '--benchmarks-root'),
        requireSignature: hasFlag(args, '--require-signature'),
        trustedKeys
      };
      console.log(
        JSON.stringify(
          apply
            ? await applyRecipePack(source, config, {
                ...options,
                dryRun: false,
                yes
              })
            : await createRecipePackPlan(source, config, options),
          null,
          2
        )
      );
    },
    'recipe-submit': async ({ args, config, command: _command }) => {
      const source = positional(args)[1];
      if (!source) {
        console.error('Missing recipe pack source');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const timeoutMs = argValue(args, '--timeout-ms');
      console.log(
        JSON.stringify(
          await submitRecipePack(source, config, {
            hostUrl: argValue(args, '--host'),
            submissionPath: argValue(args, '--submission-path'),
            trustedKeys: await loadTrustedKeys(argValues(args, '--trusted-key')),
            requireSignature: hasFlag(args, '--require-signature'),
            ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
            dryRun: !hasFlag(args, '--apply'),
            yes: hasFlag(args, '--yes')
          }),
          null,
          2
        )
      );
    },
    'add-model': async ({ args, config, command: _command }) => {
      const modelRef = positional(args)[1];
      if (!modelRef) {
        console.error('Missing model reference');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const go = wantsGo(args);
      const apply = hasFlag(args, '--apply') || go;
      const yes = hasFlag(args, '--yes');
      const contextWindow = argValue(args, '--context-window');
      const maxOutputTokens = argValue(args, '--max-output-tokens');
      const options = {
        modelRef,
        backend: argValue(args, '--backend'),
        modelRoot: argValue(args, '--model-root') ?? config.paths?.modelRoot,
        sessionCacheRoot: argValue(args, '--session-cache-root') ?? config.paths?.sessionCacheRoot,
        modelId: argValue(args, '--model-id'),
        name: argValue(args, '--name'),
        port: argValue(args, '--port'),
        ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
        ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
        apiKeyEnv: argValue(args, '--api-key-env'),
        keepWarm: hasFlag(args, '--keep-warm'),
        setDefault: hasFlag(args, '--default'),
        configPath: config.sourcePath
      };
      console.log(
        JSON.stringify(
          go
            ? await applyModelImportGo(config, options, {
                installBackend: (plan) => installModelBackendForCli(plan, args),
                downloadModel: (plan) => downloadModelForCli(plan, args),
                startRuntime: startModelRuntimeForCli
              })
            : await applyModelImport(config, {
                ...options,
                dryRun: !apply,
                yes
              }),
          null,
          2
        )
      );
    },
    voices: async ({ args, config: _config, command: _command }) => {
      const voicesRoot = argValue(args, '--voices-root') ?? defaultVoicesRoot();
      const profiles = await listVoiceProfiles({ voicesRoot });
      const report = {
        object: 'list',
        voicesRoot,
        count: profiles.length,
        data: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          kind: profile.kind,
          model: profile.model,
          refAudioPath: profile.refAudioPath,
          defaults: profile.defaults,
          tags: profile.tags
        }))
      };
      if (wantsJson(args)) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (!profiles.length) {
        console.log(`No installed voices in ${voicesRoot}`);
        console.log('Install one: lloom voice-install <id> --ref <audio> --ref-text <transcript> --apply --yes');
        return;
      }
      console.log(`LLooM voices (${profiles.length}) — ${voicesRoot}`);
      for (const profile of profiles) {
        console.log(`  ${profile.id}  (${profile.kind})  model=${profile.model}`);
      }
      console.log('Use: POST /v1/audio/speech {"voice":"<id>","input":"..."}');
    },
    'voice-show': async ({ args, config: _config, command: _command }) => {
      const voiceId = positional(args)[1];
      if (!voiceId) {
        console.error('Missing voice id');
        console.error('Usage: lloom voice-show <id>');
        process.exitCode = 2;
        return;
      }
      const voicesRoot = argValue(args, '--voices-root') ?? defaultVoicesRoot();
      const profile = await getVoiceProfile(voiceId, { voicesRoot });
      if (!profile) {
        console.error(`Voice not found: ${voiceId}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(profile, null, 2));
    },
    'voice-install': async ({ args, config: _config, command: _command }) => {
      const voiceId = positional(args)[1];
      if (!voiceId) {
        console.error('Missing voice id');
        console.error(
          'Usage: lloom voice-install <id> --ref <audio> --ref-text <transcript> [--model id] [--apply --yes]'
        );
        process.exitCode = 2;
        return;
      }
      const apply = hasFlag(args, '--apply') || wantsGo(args);
      const yes = hasFlag(args, '--yes') || wantsGo(args);
      const temperature = argValue(args, '--temperature');
      const topP = argValue(args, '--top-p');
      const topK = argValue(args, '--top-k');
      const repetitionPenalty = argValue(args, '--repetition-penalty');
      const defaults = {};
      if (temperature != null) defaults.temperature = Number(temperature);
      if (topP != null) defaults.top_p = Number(topP);
      if (topK != null) defaults.top_k = Number(topK);
      if (repetitionPenalty != null) defaults.repetition_penalty = Number(repetitionPenalty);
      try {
        const result = await installVoiceProfile({
          id: voiceId,
          name: argValue(args, '--name'),
          ref: argValue(args, '--ref'),
          refText: argValue(args, '--ref-text') ?? argValue(args, '--refText'),
          model: argValue(args, '--model') ?? 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',
          description: argValue(args, '--description'),
          tags: argValue(args, '--tags')
            ?.split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          defaults,
          voicesRoot: argValue(args, '--voices-root') ?? defaultVoicesRoot(),
          force: hasFlag(args, '--force'),
          apply,
          yes,
          dryRun: !apply
        });
        console.log(JSON.stringify(result, null, 2));
        if (!apply) {
          console.error('Dry-run only. Re-run with --apply --yes to install.');
        }
      } catch (error) {
        console.error(error?.message ?? String(error));
        process.exitCode = 1;
      }
    },
    'voice-remove': async ({ args, config: _config, command: _command }) => {
      const voiceId = positional(args)[1];
      if (!voiceId) {
        console.error('Missing voice id');
        process.exitCode = 2;
        return;
      }
      if (!hasFlag(args, '--yes')) {
        console.error('Refusing to remove without --yes');
        process.exitCode = 2;
        return;
      }
      const result = await removeVoiceProfile(voiceId, {
        voicesRoot: argValue(args, '--voices-root') ?? defaultVoicesRoot(),
        yes: true
      });
      console.log(JSON.stringify(result, null, 2));
    },
    select: async ({ args: _args, config: _config, command: _command }) => {
      const profile = await profileMachine();
      const recipes = await loadRecipes();
      const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
      console.log(
        JSON.stringify(
          {
            profile,
            selected: ranked.find((recipe) => recipe.selectable) ?? null,
            candidates: ranked
          },
          null,
          2
        )
      );
    },
    plan: async ({ args, config, command: _command }) => {
      const recipeId = positional(args)[1];
      if (!recipeId) {
        console.error('Missing recipe id');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const recipe = await loadRecipeById(recipeId);
      const catalog = await loadBackendCatalog(argValue(args, '--backend-catalog'));
      const modelRoot = argValue(args, '--model-root') ?? '${LLOOM_MODEL_ROOT}';
      const {
        evidence: benchmarkEvidence,
        validationErrors: benchmarkValidationErrors,
        root: benchmarksRoot
      } = await loadBenchmarksForCli(args);
      console.log(
        JSON.stringify(
          planRecipe(recipe, config, {
            modelRoot,
            backendIds: backendIds(catalog),
            benchmarkEvidence,
            benchmarksRoot,
            benchmarkValidationErrors
          }),
          null,
          2
        )
      );
    },
    install: async ({ args, config, command: _command }) => {
      const recipeId = positional(args)[1];
      if (!recipeId) {
        console.error('Missing recipe id');
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      const recipe = await loadRecipeById(recipeId);
      const modelRoot = argValue(args, '--model-root') ?? process.env.LLOOM_MODEL_ROOT;
      const statePath = argValue(args, '--state');
      const onlyStep = argValue(args, '--step');
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      const result = await applyRecipe(recipe, config, {
        dryRun: !apply,
        yes,
        ...(modelRoot ? { modelRoot } : {}),
        ...(statePath ? { statePath } : {}),
        ...(onlyStep ? { onlyStep } : {})
      });
      console.log(JSON.stringify(result, null, 2));
    },
    integrations: async ({ args, config, command: _command }) => {
      const clientId = positional(args)[1] ?? 'all';
      const registry = createRegistry(config);
      const home = argValue(args, '--home') ?? process.env.HOME;
      const generatedRoot = argValue(args, '--generated-root');
      const artifacts = buildIntegrationArtifacts(config, registry, {
        home,
        ...(generatedRoot ? { generatedRoot } : {})
      });
      const selected = selectIntegrationArtifacts(artifacts, clientId);
      if (!selected.length) {
        throw new Error(`Unknown integration client ${clientId}`);
      }
      console.log(
        JSON.stringify(
          await createClientIntegrationStatus(config, registry, {
            clientId,
            home,
            ...(generatedRoot ? { generatedRoot } : {})
          }),
          null,
          2
        )
      );
    },
    integrate: async ({ args, config, command: _command }) => {
      const clientId = positional(args)[1] ?? 'all';
      const registry = createRegistry(config);
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      const result = await applyIntegrationArtifacts(config, registry, {
        clientId,
        dryRun: !apply,
        yes,
        home: argValue(args, '--home') ?? process.env.HOME,
        ...(argValue(args, '--generated-root') ? { generatedRoot: argValue(args, '--generated-root') } : {})
      });
      console.log(wantsJson(args) ? JSON.stringify(result, null, 2) : formatIntegrationResult(result, clientId));
    },
    runtimes: async ({ args, config, command: _command }) => {
      const runtimeId = positional(args)[1] ?? 'all';
      const manager = runtimeManagerForCli(config);
      const status = await manager.status();
      const runtimes = runtimeId === 'all' ? status.runtimes : { [runtimeId]: status.runtimes[runtimeId] };
      if (runtimeId !== 'all' && !status.runtimes[runtimeId]) {
        throw new Error(`Unknown runtime ${runtimeId}`);
      }
      console.log(
        JSON.stringify(
          {
            config: config.sourcePath,
            defaults: config.defaults,
            keepWarm: manager.keepWarmRuntimeIds(),
            runtimes,
            events: status.events
          },
          null,
          2
        )
      );
    },
    'runtime-plan': async ({ args, config, command: _command }) => {
      const requestedRuntimeId = positional(args)[1];
      console.log(
        JSON.stringify(
          await createRuntimePolicyPlan(config, {
            requestedRuntimeId
          }),
          null,
          2
        )
      );
    },
    'runtime-admit': async ({ args, config, command }) => {
      const runtimeId = requireRuntimeId(args, command);
      if (!runtimeId) return;
      const manager = runtimeManagerForCli(config);
      console.log(
        JSON.stringify(
          await applyRuntimePolicyPlan(config, manager, {
            requestedRuntimeId: runtimeId,
            dryRun: !hasFlag(args, '--apply'),
            yes: hasFlag(args, '--yes'),
            force: !hasFlag(args, '--no-force'),
            warmup: !hasFlag(args, '--no-warmup'),
            reason: 'cli-admit'
          }),
          null,
          2
        )
      );
    },
    'runtime-start': async ({ args, config, command }) => {
      const runtimeId = requireRuntimeId(args, command);
      if (!runtimeId) return;
      const manager = runtimeManagerForCli(config);
      console.log(
        JSON.stringify(
          await manager.start(runtimeId, {
            force: !hasFlag(args, '--no-force'),
            warmup: !hasFlag(args, '--no-warmup'),
            reason: 'cli-start'
          }),
          null,
          2
        )
      );
    },
    'runtime-warmup': async ({ args, config, command }) => {
      const runtimeId = requireRuntimeId(args, command);
      if (!runtimeId) return;
      const manager = runtimeManagerForCli(config);
      console.log(JSON.stringify(await manager.warmupById(runtimeId), null, 2));
    },
    'runtime-stop': async ({ args, config, command }) => {
      const runtimeId = requireRuntimeId(args, command);
      if (!runtimeId) return;
      const manager = runtimeManagerForCli(config);
      console.log(JSON.stringify(await manager.stop(runtimeId), null, 2));
    },
    down: async ({ config }) => {
      const manager = runtimeManagerForCli(config);
      console.log(JSON.stringify(await manager.stopAll(), null, 2));
    },
    'keep-warm': async ({ config }) => {
      const manager = runtimeManagerForCli(config);
      console.log(
        JSON.stringify(
          {
            keepWarm: manager.keepWarmRuntimeIds(),
            results: await manager.startKeepWarm()
          },
          null,
          2
        )
      );
    },
    doctor: async ({ args, config, command: _command }) => {
      const noRuntimes = hasFlag(args, '--no-runtimes');
      const recipeId = argValue(args, '--recipe');
      const home = argValue(args, '--home') ?? process.env.HOME;
      const communityContext = await communityStatusCliContext(config, args, { recipeId, home });
      const report = await createDoctorReport(config, {
        recipeId: communityContext.recipeId ?? recipeId,
        modelRoot: argValue(args, '--model-root'),
        clientId: argValue(args, '--client') ?? 'all',
        home,
        generatedRoot: argValue(args, '--generated-root'),
        statePath: argValue(args, '--state'),
        benchmarksRoot:
          communityContext.benchmarksRoot ??
          argValue(args, '--benchmarks-root') ??
          config.init?.benchmarksRoot ??
          defaultBenchmarksRoot,
        benchmarkDocuments: communityContext.benchmarkDocuments,
        recipesRoot: communityContext.recipesRoot ?? argValue(args, '--recipes-root'),
        recipeDocuments: communityContext.recipeDocuments,
        includeRuntimes: !noRuntimes,
        backendVariables: backendVariablesForCli(args),
        backendCatalogPath: communityContext.backendCatalogPath ?? argValue(args, '--backend-catalog')
      });
      if (communityContext.communityPlan) {
        report.community = {
          host: communityContext.communityPlan.host,
          recommendationCount: communityContext.communityPlan.recommendationCount,
          selectedCount: communityContext.communityPlan.selectedCount,
          selectedRecipeId: communityContext.recipeId
        };
      }
      console.log(
        wantsJson(args) ? JSON.stringify(report, null, 2) : formatStatusReport(report, { title: 'LLooM doctor' })
      );
    }
  };
  handlers['up'] = handlers['onboard'];
  handlers['status'] = handlers['setup-status'];
  handlers['benchmarks-submit'] = handlers['benchmark-submit'];
  handlers['library'] = handlers['recipe-index'];
  handlers['community-plan'] = handlers['community'];
  handlers['community-sync'] = handlers['community-import'];
  handlers['validate'] = handlers['interchange'];
  handlers['pack-export'] = handlers['recipe-export'];
  handlers['recipe-pack'] = handlers['recipe-import'];
  handlers['pack-submit'] = handlers['recipe-submit'];
  handlers['model-add'] = handlers['add-model'];
  handlers['runtime-status'] = handlers['runtimes'];
  handlers['runtime-policy'] = handlers['runtime-plan'];
  handlers['voice-list'] = handlers['voices'];
  handlers['install-voice'] = handlers['voice-install'];
  handlers['voice-rm'] = handlers['voice-remove'];

  const handler = handlers[command];
  if (!handler) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  await handler({ args, config, configPath, command });
}

function formatCliError(error) {
  if (process.env.LLOOM_DEBUG) return error?.stack ?? error?.message ?? String(error);
  const message = error?.message ?? String(error);
  return message.startsWith('Error:') ? message : `Error: ${message}`;
}

main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
