import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createFirstRunServer } from './first-run.mjs';
import { createOnboardingPlan } from './onboarding.mjs';
import { applySetup } from './setup.mjs';
import { applyBootstrap } from './bootstrap.mjs';
import { profileMachine, rankRecipes } from './machine-profile.mjs';
import { loadRecipes, loadRecipeById } from './recipes.mjs';
import { loadBackendCatalog } from './backend-catalog.mjs';
import { loadConfig } from './config.mjs';

const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recipeSupportsWorkload(recipe, workload) {
  const values = new Set([
    ...(recipe.capabilities || []),
    ...(recipe.models || []).flatMap((model) => [model.kind, ...(model.capabilities || [])])
  ]);
  if (workload === 'images') return [...values].some((value) => /^image/.test(value));
  if (workload === 'voice') return [...values].some((value) => /^audio|speech|transcription|tts|stt/.test(value));
  const chat = ['chat', 'responses', 'anthropic-messages'].some((value) => values.has(value));
  return workload === 'code'
    ? chat && (values.has('tools') || (recipe.keywords || []).some((value) => /cod/.test(value)))
    : chat;
}

export function createBrowserSetup(config, options, { gatewayStarter, serverOptions = {} } = {}) {
  const evidence = async (recipeId) => ({
    recipe: await loadRecipeById(recipeId, options.recipesRoot),
    backendCatalog: await loadBackendCatalog(options.backendCatalogPath)
  });
  return createFirstRunServer({
    ...serverOptions,
    gatewayStarter,
    async planBuilder({ workloadId, recipeId }) {
      const [recipes, profile] = await Promise.all([loadRecipes(options.recipesRoot), profileMachine()]);
      const ranked = await rankRecipes(
        recipes.filter((recipe) => recipeSupportsWorkload(recipe, workloadId)),
        profile,
        { checkCommands: true }
      );
      const candidates = ranked.filter((candidate) => candidate.selectable);
      const selected = recipeId ? candidates.find((candidate) => candidate.recipeId === recipeId) : candidates[0];
      if (!selected)
        throw new Error(
          'No compatible ' +
            workloadId +
            ' recipe is available for this hardware. Choose another use or add a vendor recipe through the CLI.'
        );
      const selectedOptions = {
        ...options,
        recipeId: selected.recipeId,
        offline: true,
        start: false,
        includeRuntimes: false
      };
      const plan = await createOnboardingPlan(config, selectedOptions);
      const source = await evidence(selected.recipeId);
      plan.browserSetup = { options: selectedOptions, fingerprint: fingerprint(source) };
      const recipe = source.recipe;
      const option = (candidate) => ({
        id: candidate.recipeId,
        name: candidate.name,
        reason: candidate.reasons.length
          ? candidate.reasons.join('; ')
          : 'Compatible with ' + (profile.cpuBrand || profile.platformId) + '.',
        memoryRequiredGb: candidate.memoryRequiredGb,
        downloadSizeBytes: null,
        license:
          recipes.find((item) => item.id === candidate.recipeId)?.license?.name ||
          recipes.find((item) => item.id === candidate.recipeId)?.license?.id ||
          null,
        credentials: null
      });
      return {
        plan,
        view: {
          workloadId,
          selected: option(selected),
          alternatives: candidates
            .filter((c) => c.recipeId !== selected.recipeId)
            .slice(0, 8)
            .map(option),
          machine: {
            name: profile.cpuBrand || profile.platformId,
            platformId: profile.platformId,
            totalMemoryGb: profile.totalMemoryGb,
            accelerators: profile.accelerators || []
          },
          paths: { configPath: plan.configPath, modelRoot: plan.modelRoot },
          ports: plan.ports,
          review: {
            stages: plan.stages,
            doctorCommands: plan.next?.doctor,
            packages: (plan.setup?.phases?.bootstrap?.backend?.steps || []).map((step) => step.label || step.id),
            models: (recipe.models || []).map((model) => model.gatewayModel || model.model)
          }
        }
      };
    },
    applyRunner: createReviewedSetupRunner(config, { evidence }),
    async gatewayProbe(report, plan, gateway) {
      const installed = await loadConfig(report.configPath);
      const url = gateway?.url || report.dashboardUrl;
      const key = installed.security?.apiKeys?.[0] || installed.security?.adminApiKeys?.[0];
      const headers = { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) };
      const healthReply = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(15000) });
      const healthData = healthReply.ok ? await healthReply.json() : null;
      const health = healthData?.ok === true && (!gateway?.pid || healthData.pid === gateway.pid);
      if (!health)
        return {
          healthy: false,
          inferenceVerified: false,
          endpoint: url,
          detail: 'Installed, but the gateway did not pass its health check.'
        };
      const model = installed.models.find(
        (item) =>
          (item.kind || 'chat') === 'chat' &&
          (plan.setup?.phases?.init?.config?.models || []).some((candidate) => candidate.id === item.id)
      );
      if (!model)
        return {
          healthy: true,
          inferenceVerified: false,
          endpoint: url,
          detail: 'Gateway is running. Try the installed media model to verify its output.'
        };
      try {
        const response = await fetch(new URL('/v1/chat/completions', url), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: 'user', content: 'Reply with Ready.' }],
            max_tokens: 16,
            stream: false
          }),
          signal: AbortSignal.timeout(180000)
        });
        const body = await response.json();
        const verified =
          response.ok &&
          Array.isArray(body.choices) &&
          body.choices.some((choice) => typeof choice.message?.content === 'string' && choice.message.content.trim());
        return {
          healthy: true,
          inferenceVerified: verified,
          endpoint: url,
          detail: verified
            ? 'A model answered through your gateway.'
            : body.error?.message || 'Gateway is running, but the model did not return a text response.'
        };
      } catch (error) {
        return {
          healthy: true,
          inferenceVerified: false,
          endpoint: url,
          detail: 'Gateway is running. Model verification needs attention: ' + error.message
        };
      }
    }
  });
}

export function createReviewedSetupRunner(config, { evidence, apply = applySetup, bootstrap = applyBootstrap }) {
  let ownedConfig = null;
  return async (plan, { onProgress }) => {
    const details = plan.browserSetup;
    if (!details || fingerprint(await evidence(plan.selectedRecipe.id)) !== details.fingerprint)
      throw new Error('The recipe or backend catalog changed. Review a fresh plan.');
    // A first-run wizard must never silently replace a newly created or
    // concurrently installed configuration.
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(plan.configPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (
        !ownedConfig ||
        ownedConfig.path !== plan.configPath ||
        ownedConfig.recipeId !== plan.selectedRecipe.id ||
        fingerprint(existing) !== ownedConfig.fingerprint
      )
        throw new Error('A configuration now exists or changed. Open LLooM to manage it; setup will not overwrite it.');
      if (fingerprint(plan.setup.phases.init.config) !== ownedConfig.fingerprint)
        throw new Error(
          'The installation plan changed after configuration was created. Continue with lloom bootstrap --apply --yes to resume the installed recipe.'
        );
      // Retry only the bootstrap for the exact configuration this session
      // successfully created. Never replace it after a partial download.
      const installed = await loadConfig(plan.configPath);
      const result = await bootstrap(installed, {
        ...details.options,
        modelRoot: plan.modelRoot,
        // Retry replays the exact reviewed bootstrap evidence; never re-plan.
        reviewedPlan: plan.setup?.phases?.bootstrap,
        dryRun: false,
        yes: true,
        onProgress
      });
      return { ...result, configPath: plan.configPath, dashboardUrl: plan.dashboardUrl };
    }
    const result = await apply(config, {
      ...details.options,
      reviewedPlan: plan.setup,
      dryRun: false,
      yes: true,
      start: false,
      onProgress,
      exclusiveConfig: true,
      onConfigWritten(file, value) {
        ownedConfig = { path: file, recipeId: plan.selectedRecipe.id, fingerprint: fingerprint(value) };
      }
    });
    return { ...result, dashboardUrl: plan.dashboardUrl };
  };
}
