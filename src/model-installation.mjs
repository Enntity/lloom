import { defaultBackendVariables, getBackend, loadBackendCatalog } from './backend-catalog.mjs';
import { applyBackend } from './installer.mjs';
import { runCommand } from './process-control.mjs';

export async function installImportedModelAssets(plan, { onProgress, backendCatalog, env = process.env } = {}) {
  const variables = defaultBackendVariables(env);
  const installEnv = { ...env, PATH: [variables.shimDir, env.PATH].filter(Boolean).join(':') };
  if (plan.additions.runtimeId) {
    onProgress?.({ message: 'Installing the vendor backend' });
    const catalog = backendCatalog ?? (await loadBackendCatalog());
    const backend = getBackend(catalog, plan.inference.backend);
    if (!backend) throw new Error('Unknown backend ' + plan.inference.backend);
    const result = await applyBackend(backend, {
      dryRun: false,
      yes: true,
      variables,
      env: installEnv,
      onProgress,
      reviewedPlan: plan.backendPlan
    });
    const failed = result.results.filter((step) => ['failed', 'manual-required'].includes(step.status));
    if (failed.length)
      throw new Error(failed.map((step) => step.stderr || step.message || step.id + ' failed').join('\n'));
  }
  if (!plan.download?.command) return;
  onProgress?.({ message: 'Downloading model files. Existing files are reused.' });
  const [command, ...args] = plan.download.command;
  const result = await runCommand(command, args, { allowFailure: true, env: installEnv, stdio: 'inherit' });
  if (result.code !== 0)
    throw new Error(result.stderr || 'Model download failed. Check the vendor requirements and credentials.');
}
