import { defaultBackendVariables, getBackend, loadBackendCatalog } from './backend-catalog.mjs';
import { applyBackend } from './installer.mjs';
import { runCommand } from './process-control.mjs';
import {
  modelAcquisitionStatus,
  prepareModelAcquisition,
  finalizeModelAcquisition,
  recoverModelAcquisitionDestination
} from './model-acquisition.mjs';

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
  const acquisition = plan.download.acquisition;
  if (plan.reference?.type === 'huggingface' && !acquisition)
    throw new Error('Hugging Face imports require a reviewed acquisition plan.');
  if (acquisition && (await modelAcquisitionStatus(acquisition)).complete) return;
  const prepared = acquisition ? await prepareModelAcquisition(acquisition) : null;
  const planned = plan.download.command;
  const [command, ...args] = prepared
    ? planned.map((arg, index) => (planned[index - 1] === '--local-dir' ? prepared.workPath : arg))
    : planned;
  let result;
  try {
    result = await runCommand(command, args, { allowFailure: true, env: installEnv, stdio: 'inherit' });
  } catch (error) {
    const recovery = prepared ? await recoverModelAcquisitionDestination(prepared) : { restored: false };
    throw new Error([error?.message ?? String(error), recovery.recoveryError].filter(Boolean).join('\n'), {
      cause: error
    });
  }
  if (result.code !== 0) {
    if (prepared) {
      const recovery = await recoverModelAcquisitionDestination(prepared);
      if (recovery.recoveryError) {
        throw new Error(
          [
            result.stderr || 'Model download failed. Check the vendor requirements and credentials.',
            recovery.recoveryError
          ]
            .filter(Boolean)
            .join('\n')
        );
      }
    }
    throw new Error(result.stderr || 'Model download failed. Check the vendor requirements and credentials.');
  }
  if (prepared) {
    try {
      await finalizeModelAcquisition(acquisition, prepared);
    } catch (error) {
      const recovery = await recoverModelAcquisitionDestination(prepared);
      throw new Error([error?.message ?? String(error), recovery.recoveryError].filter(Boolean).join('\n'), {
        cause: error
      });
    }
  }
}
