import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeBenchmarksForRecipe } from './benchmarks.mjs';
import { validateAcquisitionStep } from './model-acquisition.mjs';
import { repoRoot } from './config.mjs';

export const recipesRoot = path.join(repoRoot, 'recipes');
export const RECIPE_SCHEMA = 'https://lloom.dev/schemas/recipe.v1.schema.json';

function machineId({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function commandLine(step, variables = {}) {
  const args = asArray(step.args).map((arg) => expandTemplate(String(arg), variables));
  const command = step.command ? expandTemplate(String(step.command), variables) : step.command;
  return [command, ...args].filter(Boolean);
}

function expandTemplate(value, variables) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => variables[name] ?? '');
}

function configModelIds(config) {
  return new Set((config.models ?? []).map((model) => model.id));
}

function configRuntimeIds(config) {
  return new Set(Object.keys(config.runtimes ?? {}));
}

function validateRecipeModes(recipe) {
  if (recipe.modes === undefined) return [];
  const prefix = `recipe ${recipe.id ?? '(missing)'}`;
  if (!asArray(recipe.modes).length) return [`${prefix} modes must be a non-empty array`];
  const errors = [];
  const seen = new Set();
  for (const mode of recipe.modes) {
    if (!mode?.id) {
      errors.push(`${prefix} has a mode without id`);
      continue;
    }
    if (seen.has(mode.id)) errors.push(`${prefix} mode ${mode.id} is declared twice`);
    seen.add(mode.id);
    for (const [key, value] of Object.entries(mode.settings ?? {})) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        errors.push(`${prefix} mode ${mode.id} setting ${key} must be a string, number or boolean`);
      }
    }
  }
  if (recipe.modes.filter((mode) => mode?.default === true).length !== 1) {
    errors.push(`${prefix} must mark exactly one default mode`);
  }
  return errors;
}

// A mode is a named set of primitive setting overrides that a recipe offers
// (for example a pair that serves alone or leaves room for sidecars). The
// selected mode's settings replace each model's, so they also reach every
// ${name} template; the returned recipe records the mode it was built for.
export function applyRecipeMode(recipe, modeId) {
  const modes = asArray(recipe.modes);
  if (!modes.length) {
    if (modeId) throw new Error(`recipe ${recipe.id} declares no modes`);
    return recipe;
  }
  const mode = modeId
    ? modes.find((candidate) => candidate.id === modeId)
    : modes.find((candidate) => candidate.default);
  if (!mode) {
    throw new Error(`recipe ${recipe.id} has no mode ${modeId}; its modes are ${modes.map((m) => m.id).join(', ')}`);
  }
  return {
    ...recipe,
    mode: mode.id,
    models: asArray(recipe.models).map((model) => ({
      ...model,
      settings: { ...model.settings, ...mode.settings }
    }))
  };
}

// Options are named choices a recipe declares, each with a fixed set of
// values (for example sparks 2|4 and drafter v80|dflash2). Anywhere in the
// document, {"$option": NAME, VALUE: branch, ...} picks the branch for the
// selected value: inside an array an array branch is spliced in, and a null
// branch drops the element or key. ${VAR} in strings takes the variables of
// the selected values; other ${...} templates are left for runtime. A
// default may itself be an $option node over an earlier option. Recipes load
// resolved with their defaults, so every reader sees a plain document; the
// declaration stays as recipe.options and the choice as recipe.selectedOptions.
const OPTION_SOURCE = Symbol('recipe option source');
// Setup reads option values from --NAME VALUE, so a name must not be a flag.
const RESERVED_OPTION_NAMES = new Set([
  'additive',
  'apply',
  'backend-catalog',
  'backend-model-root',
  'backend-port-range',
  'backend-root',
  'benchmarks-root',
  'client',
  'config-out',
  'format',
  'generated-root',
  'home',
  'install-root',
  'integrate',
  'json',
  'mode',
  'model-root',
  'port',
  'recipe',
  'recipe-version',
  'recipes-root',
  'repo-parent',
  'restore-catalog',
  'shim-dir',
  'start',
  'state',
  'yes'
]);
const MAX_OPTION_COMBINATIONS = 64;

function isOptionNode(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.$option === 'string';
}

function optionBranch(node, selected, where) {
  if (!Object.hasOwn(selected, node.$option)) throw new Error(`${where} selects on undeclared option ${node.$option}`);
  const value = selected[node.$option];
  if (!Object.hasOwn(node, value)) throw new Error(`${where} has no branch for ${node.$option}=${value}`);
  return node[value];
}

function resolveOptionNodes(value, selected, variables, where) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
      Object.hasOwn(variables, name) ? String(variables[name]) : match
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const at = `${where}[${index}]`;
      if (!isOptionNode(item)) return [resolveOptionNodes(item, selected, variables, at)];
      const branch = optionBranch(item, selected, at);
      if (branch == null) return [];
      return (Array.isArray(branch) ? branch : [branch]).map((entry) =>
        resolveOptionNodes(entry, selected, variables, at)
      );
    });
  }
  if (!value || typeof value !== 'object') return value;
  if (isOptionNode(value)) return resolveOptionNodes(optionBranch(value, selected, where), selected, variables, where);
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    const at = `${where}.${key}`;
    const branch = isOptionNode(item) ? optionBranch(item, selected, at) : item;
    if (isOptionNode(item) && branch == null) continue;
    entries.push([key, resolveOptionNodes(branch, selected, variables, at)]);
  }
  return Object.fromEntries(entries);
}

function resolveRecipeOptions(source, requested = {}) {
  const selected = {};
  const variables = {};
  for (const [name, option] of Object.entries(source.options)) {
    const values = asObject(option?.values);
    const fallback = isOptionNode(option?.default)
      ? optionBranch(option.default, selected, `recipe ${source.id} option ${name} default`)
      : option?.default;
    const value = String(requested[name] ?? fallback);
    if (!Object.hasOwn(values, value)) {
      throw new Error(
        `recipe ${source.id} option ${name} has no value ${value}; its values are ${Object.keys(values).join(', ')}`
      );
    }
    selected[name] = value;
    Object.assign(variables, values[value]?.variables);
  }
  const { options, ...body } = source;
  const recipe = {
    ...resolveOptionNodes(body, selected, variables, `recipe ${source.id}`),
    options,
    selectedOptions: selected
  };
  Object.defineProperty(recipe, OPTION_SOURCE, { value: source });
  return recipe;
}

// A recipe as read from a file or a recipe pack: resolved with its defaults.
// One that cannot resolve stays as written, so validateRecipe reports why and
// one broken file does not stop every other recipe from loading.
export function prepareRecipeDocument(document) {
  if (!document?.options || document[OPTION_SOURCE]) return document;
  try {
    return resolveRecipeOptions(document);
  } catch {
    const unresolved = { ...document };
    Object.defineProperty(unresolved, OPTION_SOURCE, { value: document });
    return unresolved;
  }
}

// The recipe for the requested option values, with defaults for the rest (a
// default that depends on another option follows the requested value). Names
// it does not declare are ignored, since setup passes every --NAME VALUE pair.
export function applyRecipeOptions(recipe, requested = {}) {
  if (!recipe?.options) return recipe;
  const source = recipe[OPTION_SOURCE];
  if (!source) throw new Error(`recipe ${recipe.id} lost its option source; load it again to change its options`);
  const relevant = Object.fromEntries(
    Object.entries(requested).filter(([name, value]) => Object.hasOwn(source.options, name) && value != null)
  );
  return resolveRecipeOptions(source, relevant);
}

// The options a recipe was last installed with (runtimes.*.recipe.options).
export function installedRecipeOptions(config, recipeId) {
  const runtime = Object.values(config?.runtimes ?? {}).find(
    (candidate) => candidate?.recipe?.id === recipeId && candidate.recipe.options
  );
  return { ...runtime?.recipe.options };
}

// The recipe as this config installed it, with any requested values on top; a
// remembered value the recipe no longer offers falls back to its default.
export function recipeWithInstalledOptions(recipe, config, requested = {}) {
  if (!recipe?.options) return recipe;
  const remembered = Object.entries(installedRecipeOptions(config, recipe.id)).filter(([name, value]) =>
    Object.hasOwn(recipe.options[name]?.values ?? {}, value)
  );
  const wanted = { ...Object.fromEntries(remembered), ...requested };
  const unchanged = Object.entries(wanted).every(
    ([name, value]) => !Object.hasOwn(recipe.options, name) || recipe.selectedOptions?.[name] === String(value)
  );
  return unchanged && !Object.keys(requested).length ? recipe : applyRecipeOptions(recipe, wanted);
}

// The --NAME VALUE flags that select these option values, for printed commands.
export function recipeOptionFlags(options, quote = String) {
  return Object.entries(asObject(options)).flatMap(([name, value]) => [`--${name}`, quote(String(value))]);
}

// Every combination of option values, in declaration order.
export function recipeOptionCombinations(recipe) {
  return Object.entries(asObject(recipe?.options)).reduce(
    (combinations, [name, option]) =>
      combinations.flatMap((combination) =>
        Object.keys(asObject(option?.values)).map((value) => ({ ...combination, [name]: value }))
      ),
    [{}]
  );
}

function validateRecipeOptions(recipe) {
  if (recipe.options === undefined) return [];
  const prefix = `recipe ${recipe.id ?? '(missing)'}`;
  const options = asObject(recipe.options);
  if (!Object.keys(options).length) return [`${prefix} options must declare at least one option`];
  const errors = [];
  for (const [name, option] of Object.entries(options)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`${prefix} option ${name} must be lowercase letters, digits or -`);
    if (RESERVED_OPTION_NAMES.has(name)) errors.push(`${prefix} option ${name} clashes with a setup flag`);
    const values = asObject(option?.values);
    if (!Object.keys(values).length) errors.push(`${prefix} option ${name} declares no values`);
    const defaults = isOptionNode(option?.default)
      ? Object.entries(option.default)
          .filter(([key]) => key !== '$option')
          .map(([, value]) => value)
      : [option?.default];
    for (const value of defaults) {
      if (!Object.hasOwn(values, String(value)))
        errors.push(`${prefix} option ${name} default ${value} is not one of its values`);
    }
    for (const [value, choice] of Object.entries(values)) {
      for (const [key, variable] of Object.entries(asObject(choice?.variables))) {
        if (!['string', 'number', 'boolean'].includes(typeof variable)) {
          errors.push(`${prefix} option ${name} value ${value} variable ${key} must be a string, number or boolean`);
        }
      }
    }
  }
  if (errors.length) return errors;
  const combinations = recipeOptionCombinations(recipe).length;
  if (combinations > MAX_OPTION_COMBINATIONS) {
    errors.push(`${prefix} options allow ${combinations} combinations; at most ${MAX_OPTION_COMBINATIONS}`);
  }
  return errors;
}

export function modelPathSegmentForRecipe(recipe, modelId) {
  if (!modelId || modelId.startsWith('/') || modelId.startsWith('.')) return modelId;
  if (recipe.backend?.id === 'ollama') return modelId;
  // Hugging Face repos are downloaded into a flat cache directory so runtime
  // paths line up with config materialization in init/model-intake.
  if (String(modelId).includes('/')) return modelId.replace(/\//g, '--');
  return modelId;
}

export async function listRecipeFiles(root = recipesRoot) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json')
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export async function readRecipe(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const recipe = JSON.parse(raw);
  return prepareRecipeDocument({
    ...recipe,
    filePath
  });
}

export async function loadRecipes(root = recipesRoot) {
  const files = await listRecipeFiles(root);
  return Promise.all(files.map((file) => readRecipe(file)));
}

// A recipe with options is valid when its declaration is and every combination
// of values resolves to a valid recipe; a raw or resolved document both work.
export function validateRecipe(recipe, config, settings = {}) {
  if (recipe?.options === undefined) return validateResolvedRecipe(recipe, config, settings);
  const declarationErrors = validateRecipeOptions(recipe);
  if (declarationErrors.length) return declarationErrors;
  const source = recipe[OPTION_SOURCE] ?? recipe;
  const errors = new Set();
  for (const combination of recipeOptionCombinations(source)) {
    try {
      for (const error of validateResolvedRecipe(resolveRecipeOptions(source, combination), config, settings)) {
        errors.add(error);
      }
    } catch (error) {
      errors.add(error.message);
    }
  }
  return [...errors];
}

function validateResolvedRecipe(recipe, config, { backendIds, checkLocalReferences = true } = {}) {
  const errors = [];
  if (recipe.$schema && recipe.$schema !== RECIPE_SCHEMA) {
    errors.push(`recipe ${recipe.id ?? '(missing)'} has unsupported $schema ${recipe.$schema}`);
  }
  if (recipe.schemaVersion !== 1) errors.push(`recipe ${recipe.id ?? '(missing)'} schemaVersion must be 1`);
  if (!recipe.id) errors.push('recipe is missing id');
  if (!recipe.name) errors.push(`recipe ${recipe.id ?? '(missing)'} is missing name`);
  if (!recipe.backend?.id) errors.push(`recipe ${recipe.id ?? '(missing)'} is missing backend.id`);
  if (recipe.backend?.id && backendIds && !backendIds.has(recipe.backend.id)) {
    errors.push(`recipe ${recipe.id ?? '(missing)'} references unknown backend ${recipe.backend.id}`);
  }
  if (!asArray(recipe.models).length) errors.push(`recipe ${recipe.id ?? '(missing)'} has no models`);
  errors.push(...validateRecipeModes(recipe));

  const modelIds = checkLocalReferences ? configModelIds(config) : new Set();
  const runtimeIds = checkLocalReferences ? configRuntimeIds(config) : new Set();
  for (const model of asArray(recipe.models)) {
    if (!model.role) errors.push(`recipe ${recipe.id} has model without role`);
    if (!model.model) errors.push(`recipe ${recipe.id} model ${model.role ?? '(missing)'} is missing model`);
    if (checkLocalReferences && model.gatewayModel && !modelIds.has(model.gatewayModel)) {
      errors.push(`recipe ${recipe.id} references unknown gateway model ${model.gatewayModel}`);
    }
    if (checkLocalReferences && model.runtime && !runtimeIds.has(model.runtime)) {
      errors.push(`recipe ${recipe.id} references unknown runtime ${model.runtime}`);
    }
  }

  for (const step of asArray(recipe.setup?.steps)) {
    if (!step.id) errors.push(`recipe ${recipe.id} has setup step without id`);
    if (!step.action) errors.push(`recipe ${recipe.id} setup step ${step.id ?? '(missing)'} has no action`);
    if (['command', 'check-command'].includes(step.action) && !step.command) {
      errors.push(`recipe ${recipe.id} setup step ${step.id} action ${step.action} requires command`);
    }
    if (step.action === 'download-model' && !step.model) {
      errors.push(`recipe ${recipe.id} setup step ${step.id} download-model requires model`);
    }
    if (step.action === 'download-model') {
      errors.push(
        ...validateAcquisitionStep(step).map(
          (error) => `recipe ${recipe.id} setup step ${step.id ?? '(missing)'} ${error}`
        )
      );
    }
  }

  return errors;
}

export function planRecipe(
  recipe,
  config,
  {
    modelRoot = '${LLOOM_MODEL_ROOT}',
    variables = {},
    platform = process.platform,
    arch = process.arch,
    backendIds,
    checkLocalReferences = true,
    benchmarkEvidence,
    benchmarksRoot,
    benchmarkValidationErrors = []
  } = {}
) {
  // Recipe setup commands use the same managed variable vocabulary as backend
  // commands. Keep repoRoot/modelRoot available for standalone recipe plans,
  // while callers such as setup pass the complete backend variable set
  // (backendRoot, installRoot, shimDir, ...).
  const templateVariables = {
    repoRoot,
    ...variables,
    modelRoot
  };
  const platformId = machineId({ platform, arch });
  const supportedPlatforms = asArray(recipe.requirements?.platforms);
  const platformSupported = !supportedPlatforms.length || supportedPlatforms.includes(platformId);
  const validationErrors = validateRecipe(recipe, config, { backendIds, checkLocalReferences });
  const benchmarkSummaries = benchmarkEvidence
    ? new Map(summarizeBenchmarksForRecipe(recipe, benchmarkEvidence).map((summary) => [summary.role, summary]))
    : null;
  const steps = asArray(recipe.setup?.steps).map((step) => {
    const planned = {
      id: step.id,
      title: step.title ?? step.id,
      action: step.action
    };
    // alwaysRun gates describe external state that can change without the
    // step id or command changing (pins, images, converted overlays). Preserve
    // the flag through planning so apply and setup-status re-run them instead
    // of trusting a stale completed record.
    if (step.alwaysRun === true) planned.alwaysRun = true;
    if (step.action === 'download-model') {
      planned.provider = step.provider ?? 'huggingface';
      planned.model = step.model;
      if (step.revision) planned.revision = step.revision;
      if (step.downloadSizeBytes != null) planned.downloadSizeBytes = step.downloadSizeBytes;
      if (step.integrity) planned.integrity = step.integrity;
      if (Array.isArray(step.include) && step.include.length) planned.include = step.include;
      planned.destination = path.posix.join(modelRoot, modelPathSegmentForRecipe(recipe, step.model));
      const selections = planned.include?.length ? planned.include.map((entry) => [entry]) : [undefined];
      planned.commands = selections.map((include) => [
        'hf',
        'download',
        step.model,
        ...(step.revision ? ['--revision', step.revision] : []),
        ...(include ? ['--include', ...include] : []),
        '--local-dir',
        planned.destination
      ]);
      planned.command = planned.commands[0];
    } else if (['command', 'check-command'].includes(step.action)) {
      planned.command = commandLine(step, templateVariables);
    }
    if (step.skipIfPathExists) {
      planned.skipIfPathExists = expandTemplate(String(step.skipIfPathExists), templateVariables);
    }
    return planned;
  });

  return {
    id: recipe.id,
    name: recipe.name,
    version: recipe.version ?? 1,
    platform: platformId,
    platformSupported,
    requirements: recipe.requirements ?? {},
    backend: recipe.backend ?? null,
    validationErrors,
    ...(benchmarkSummaries
      ? {
          benchmarks: {
            root: benchmarksRoot ?? null,
            validationErrors: benchmarkValidationErrors,
            models: [...benchmarkSummaries.values()]
          }
        }
      : {}),
    models: asArray(recipe.models).map((model) => ({
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      upstreamModel: model.upstreamModel,
      runtime: model.runtime,
      settings: model.settings ?? {},
      observed: model.observed ?? {},
      ...(benchmarkSummaries ? { benchmark: benchmarkSummaries.get(model.role) ?? null } : {})
    })),
    steps
  };
}

// A version index.json lists, such as a candidate still qualifying. Setup without
// a version installs the current file; a candidate never becomes the default.
export async function loadRecipeVersion(recipeId, version, root = recipesRoot) {
  const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'));
  const entry = asArray(index.recipes).find((candidate) => candidate.id === recipeId);
  if (!entry) throw new Error(`Unknown recipe ${recipeId}`);
  const versions = asArray(entry.versions);
  const listed = versions.find((candidate) => candidate.version === Number(version));
  if (!listed) {
    throw new Error(
      `recipe ${recipeId} has no version ${version}; its versions are ${versions.map((v) => v.version).join(', ')}`
    );
  }
  const filePath = path.resolve(root, String(listed.path));
  if (path.relative(root, filePath).startsWith('..')) {
    throw new Error(`recipe ${recipeId} version ${version} path must stay inside the recipes root`);
  }
  const recipe = await readRecipe(filePath);
  if (recipe.id !== recipeId || recipe.version !== listed.version) {
    throw new Error(`recipe ${recipeId} version ${version} file declares ${recipe.id} version ${recipe.version}`);
  }
  return recipe;
}

export async function loadRecipeById(recipeId, root = recipesRoot) {
  const recipes = await loadRecipes(root);
  const recipe = recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) {
    const known = recipes.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown recipe ${recipeId}. Known recipes: ${known || '(none)'}`);
  }
  return recipe;
}
