import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createInstallationJobs } from './installation-jobs.mjs';
import { createModelImportPlan } from './model-intake.mjs';
import { createSetupPlan, applySetup } from './setup.mjs';
import { loadRecipeById } from './recipes.mjs';
import { loadBackendCatalog, getBackend, planBackend } from './backend-catalog.mjs';
import { loadConfig } from './config.mjs';
import { mutateConfigSource } from './config-mutation.mjs';
import { pinDownloadCommands } from './installer.mjs';
import { installImportedModelAssets } from './model-installation.mjs';
import { validateAcquisitionStep } from './model-acquisition.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message) => Object.assign(new Error(message), { statusCode: 409 });
export function createDashboardInstallation({ getConfig, reload, env = process.env }) {
  const source = async () => {
    if (!getConfig().sourcePath) throw invalid('Installations need a writable LLooM configuration.');
    return loadConfig(getConfig().sourcePath);
  };
  const evidence = async (recipeId) => ({
    catalog: await loadBackendCatalog(),
    recipe: recipeId ? await loadRecipeById(recipeId) : null
  });
  return createInstallationJobs({
    async plan(input) {
      if (!input || Object.keys(input).some((key) => !['recipeId', 'modelRef', 'backend', 'name'].includes(key)))
        throw invalid('Choose a vendor recipe or model reference.');
      if (Boolean(input.recipeId) === Boolean(input.modelRef))
        throw invalid('Choose exactly one recipe or model reference.');
      for (const value of Object.values(input))
        if (typeof value !== 'string' || value.length > 2000) throw invalid('Invalid model reference.');
      const config = await source();
      const baseline = digest(JSON.parse(await fs.readFile(config.sourcePath, 'utf8')));
      const sources = await evidence(input.recipeId);
      const options = {
        ...input,
        configPath: config.sourcePath,
        additive: true,
        offline: true,
        start: false,
        includeRuntimes: false
      };
      const plan = input.recipeId ? await createSetupPlan(config, options) : createModelImportPlan(config, options);
      if (
        !input.recipeId &&
        plan.reference.type === 'huggingface' &&
        !/^[a-f0-9]{40,64}$/i.test(plan.reference.revision || '')
      )
        throw invalid(
          'Use a Hugging Face file or repository link pinned to a commit, such as /tree/<commit>. Branches and latest references cannot bind a reviewed installation.'
        );
      if (!input.recipeId && plan.additions.runtimeId) {
        const backend = getBackend(sources.catalog, plan.inference.backend);
        if (!backend) throw invalid('Unknown vendor backend.');
        plan.backendPlan = await planBackend(backend);
      }
      if (!input.recipeId && plan.download?.command?.[0] === 'hf') {
        const command = plan.download.command;
        const pinned = await pinDownloadCommands(
          {
            steps: [
              {
                action: 'download-model',
                provider: 'huggingface',
                model: command[2],
                revision: plan.reference.revision,
                include: plan.reference.filePath ? [plan.reference.filePath] : [],
                destination: command[command.indexOf('--local-dir') + 1],
                command,
                commands: [command]
              }
            ]
          },
          { env, requireAvailable: true }
        );
        const errors = validateAcquisitionStep(pinned.steps[0]);
        if (plan.reference.filePath?.startsWith('-'))
          errors.push('Model file names cannot begin with a command option.');
        if (errors.length) throw invalid(errors.join('; '));
        plan.download.acquisition = pinned.steps[0];
        plan.download.command = pinned.steps[0].command;
        delete plan.download.shellCommand;
      }
      return {
        input,
        options,
        plan,
        baseline,
        sources,
        digest: digest(sources),
        view: {
          kind: input.recipeId ? 'recipe' : 'model',
          summary:
            'Installs the vendor backend and model files, then adds the model to this gateway. Loading uses normal memory admission.',
          details: input.recipeId
            ? {
                recipe: plan.selectedRecipe,
                configPath: plan.configPath,
                modelRoot: plan.modelRoot,
                ports: plan.ports,
                backend: plan.phases.bootstrap.backend,
                models: plan.phases.bootstrap.recipe,
                integrations: plan.phases.bootstrap.integrations
              }
            : {
                reference: plan.reference,
                backend: plan.inference,
                backendInstallation: plan.backendPlan,
                additions: plan.additions,
                download: plan.download,
                configPath: plan.configPath
              }
        }
      };
    },
    async apply(prepared, onProgress) {
      if (digest(await evidence(prepared.input.recipeId)) !== prepared.digest)
        throw invalid('The vendor recipe changed. Review a fresh plan.');
      const config = await source();
      if (digest(JSON.parse(await fs.readFile(config.sourcePath, 'utf8'))) !== prepared.baseline)
        throw invalid('Your configuration changed. Review a fresh installation plan.');
      const writeConfig = async (file, value) => {
        if (file !== config.sourcePath) throw invalid('The installation destination changed.');
        await mutateConfigSource(config, (raw) => {
          if (digest(raw) !== prepared.baseline)
            throw invalid(
              'Your configuration changed during installation. Files are retained; review a fresh plan to continue.'
            );
          for (const key of Object.keys(raw)) delete raw[key];
          Object.assign(raw, value);
        });
      };
      let result;
      if (prepared.input.recipeId) {
        result = await applySetup(config, {
          ...prepared.options,
          reviewedPlan: prepared.plan,
          dryRun: false,
          yes: true,
          onProgress,
          writeConfig
        });
      } else {
        await installImportedModelAssets(prepared.plan, { onProgress, backendCatalog: prepared.sources.catalog });
        await writeConfig(config.sourcePath, prepared.plan.config);
        result = { ok: true };
      }
      // Even failed bootstrap can have written configuration. Surface reload
      // failures, and make the installed/failed state visible in the dashboard.
      await reload();
      return result;
    }
  });
}
