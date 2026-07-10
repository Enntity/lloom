import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backendIds as catalogBackendIds, loadBackendCatalog } from './backend-catalog.mjs';
import { validateBenchmarkSuite } from './benchmarks.mjs';
import { defaultRecipeIndexPath, loadRecipeIndex, validateRecipeIndex } from './recipe-index.mjs';
import { recipesRoot as defaultRecipesRoot, validateRecipe } from './recipes.mjs';
import { defaultBenchmarksRoot } from './benchmarks.mjs';

export const RECIPE_PACK_SCHEMA = 'https://lloom.dev/schemas/recipe-pack.v1.schema.json';
export const RECIPE_PACK_MEDIA_TYPE = 'application/vnd.lloom.recipe-pack+json;version=1';
export const RECIPE_PACK_SUBMISSION_RESPONSE_SCHEMA =
  'https://lloom.dev/schemas/recipe-pack-submission-response.v1.schema.json';
export const RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE =
  'application/vnd.lloom.recipe-pack-submission-response+json;version=1';
export const INTERCHANGE_PROFILE = 'https://lloom.dev/profiles/interchange/v1';
export const defaultRecipePackSubmissionPath = '/v1/recipe-packs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function submissionUrl({ hostUrl, submissionPath = defaultRecipePackSubmissionPath }) {
  if (!hostUrl) throw new Error('community.hostUrl is not configured');
  return `${stripTrailingSlash(hostUrl)}${submissionPath.startsWith('/') ? '' : '/'}${submissionPath}`;
}

function recipePackSubmissionOptions(config, options = {}) {
  const community = asObject(config?.community);
  return {
    hostUrl: options.hostUrl ?? community.hostUrl,
    submissionPath: options.submissionPath ?? community.recipePackSubmissionPath ?? defaultRecipePackSubmissionPath,
    timeoutMs: options.timeoutMs ?? community.timeoutMs ?? 30000,
    indexPath: options.indexPath,
    recipesRoot: options.recipesRoot,
    benchmarksRoot: options.benchmarksRoot,
    trustedKeys: options.trustedKeys ?? [],
    requireSignature: options.requireSignature ?? false
  };
}

function ensureRelativePath(relativePath, label) {
  if (!relativePath) throw new Error(`${label} is missing path`);
  if (path.isAbsolute(relativePath)) throw new Error(`${label} path must be relative`);
  const normalized = path.normalize(relativePath);
  if (normalized === '.' || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw new Error(`${label} path must stay inside the target root`);
  }
  return normalized;
}

function resolveInside(root, relativePath, label) {
  const normalized = ensureRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes target root`);
  }
  return resolved;
}

function defaultIndexEntry(recipeEntry) {
  const recipe = recipeEntry.recipe ?? {};
  return {
    id: recipe.id,
    path: `${recipe.id}.json`,
    name: recipe.name,
    summary: recipe.summary,
    tags: asArray(recipeEntry.tags),
    recommendedFor: asArray(recipeEntry.recommendedFor),
    source: recipeEntry.source ?? {
      type: 'recipe-pack'
    }
  };
}

function safeJsonFileName(value) {
  const safe = String(value ?? 'benchmark')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fileName = safe || 'benchmark';
  return fileName.endsWith('.json') ? fileName : `${fileName}.json`;
}

async function readJsonSource(source) {
  if (!source) throw new Error('recipe pack source is required');
  if (typeof source === 'object') {
    return {
      source: null,
      json: source
    };
  }
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch recipe pack ${source}: HTTP ${response.status}`);
    return {
      source,
      json: await response.json()
    };
  }
  const filePath = path.resolve(source);
  return {
    source: filePath,
    json: JSON.parse(await fs.readFile(filePath, 'utf8'))
  };
}

async function existingIndex(indexPath) {
  try {
    return await loadRecipeIndex(indexPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      schemaVersion: 1,
      id: 'lloom-community-recipes',
      name: 'LLooM Community Recipe Index',
      recipes: [],
      filePath: path.resolve(indexPath)
    };
  }
}

async function fileStatus(filePath, expectedContent) {
  try {
    const current = await fs.readFile(filePath, 'utf8');
    return current === expectedContent ? 'current' : 'replace';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return 'create';
  }
}

function mergeIndex(index, entries, updatedAt) {
  const byId = new Map(asArray(index.recipes).map((entry) => [entry.id, entry]));
  for (const entry of entries) byId.set(entry.id, entry);
  return {
    ...index,
    updatedAt: updatedAt ?? index.updatedAt ?? new Date().toISOString(),
    recipes: [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
}

function benchmarkResults(suite) {
  return Array.isArray(suite.results) ? suite.results : [suite];
}

function validatePackEntry(entry, config, backendIds) {
  const errors = [];
  const recipe = entry.recipe;
  const index = entry.index ?? defaultIndexEntry(entry);
  if (!recipe) {
    errors.push('recipe pack entry is missing recipe');
    return { index, errors };
  }
  if (!index.id) errors.push(`recipe pack entry for ${recipe.id ?? '(missing)'} is missing index.id`);
  if (index.id && recipe.id && index.id !== recipe.id) {
    errors.push(`recipe pack entry ${index.id} recipe id mismatch: ${recipe.id}`);
  }
  try {
    ensureRelativePath(index.path, `recipe pack entry ${index.id ?? recipe.id ?? '(missing)'}`);
  } catch (error) {
    errors.push(error.message);
  }
  errors.push(...validateRecipe(recipe, config, { backendIds, checkLocalReferences: false }));

  const recipeModels = new Set(
    asArray(recipe.models).flatMap((model) => [model.model, model.gatewayModel].filter(Boolean))
  );
  for (const suite of asArray(entry.benchmarks)) {
    for (const result of benchmarkResults(suite)) {
      if (result.recipeId !== recipe.id) {
        errors.push(`benchmark ${result.id ?? '(missing)'} recipeId must be ${recipe.id}`);
      }
      const identifiers = [result.model, result.gatewayModel].filter(Boolean);
      if (identifiers.length && !identifiers.some((identifier) => recipeModels.has(identifier))) {
        errors.push(`benchmark ${result.id ?? '(missing)'} model does not match recipe ${recipe.id}`);
      }
    }
    errors.push(...validateBenchmarkSuite(suite));
  }
  return { index, errors };
}

export async function loadRecipePack(source) {
  const loaded = await readJsonSource(source);
  const pack = { ...loaded.json };
  Object.defineProperty(pack, 'source', {
    value: loaded.source,
    enumerable: false
  });
  return pack;
}

export async function readRecipePackSubmission(source) {
  const loaded = await readJsonSource(source);
  return {
    source: loaded.source,
    pack: loaded.json
  };
}

export function recipePackSigningPayload(pack) {
  const payload = {
    ...pack
  };
  delete payload.signatures;
  delete payload.source;
  return Buffer.from(canonicalJson(payload), 'utf8');
}

export function createRecipePackSignature(pack, { keyId, privateKey, publicKey } = {}) {
  if (!keyId) throw new Error('keyId is required');
  if (!privateKey) throw new Error('privateKey is required');
  return {
    keyId,
    algorithm: 'ed25519',
    canonicalization: 'lloom-canonical-json-v1',
    ...(publicKey ? { publicKey } : {}),
    signature: crypto.sign(null, recipePackSigningPayload(pack), privateKey).toString('base64')
  };
}

async function trustedKeyEntry(spec) {
  if (!spec) return null;
  if (typeof spec === 'object') {
    if (!spec.keyId || !spec.publicKey) throw new Error('trusted key objects require keyId and publicKey');
    return {
      keyId: spec.keyId,
      publicKey: spec.publicKey
    };
  }
  const text = String(spec);
  const splitAt = text.indexOf('=');
  if (splitAt === -1) throw new Error(`trusted key must use key-id=public-key-file: ${text}`);
  const keyId = text.slice(0, splitAt);
  let value = text.slice(splitAt + 1);
  if (!keyId || !value) throw new Error(`trusted key must use key-id=public-key-file: ${text}`);
  if (value.startsWith('@')) value = value.slice(1);
  const publicKey = value.includes('-----BEGIN') ? value : await fs.readFile(path.resolve(value), 'utf8');
  return {
    keyId,
    publicKey
  };
}

export async function loadTrustedKeys(specs = []) {
  const keys = [];
  for (const spec of asArray(specs)) {
    const entry = await trustedKeyEntry(spec);
    if (entry) keys.push(entry);
  }
  return keys;
}

function verifySignature(signature, payload, trustedKeyById) {
  const keyId = signature?.keyId ?? null;
  const algorithm = signature?.algorithm ?? null;
  const trustedPublicKey = keyId ? trustedKeyById.get(keyId) : null;
  const publicKey = trustedPublicKey ?? signature?.publicKey;
  const result = {
    keyId,
    algorithm,
    verified: false,
    trusted: Boolean(trustedPublicKey)
  };
  if (!keyId) return { ...result, error: 'signature is missing keyId' };
  if (algorithm !== 'ed25519')
    return { ...result, error: `unsupported signature algorithm ${algorithm ?? '(missing)'}` };
  if (signature.canonicalization && signature.canonicalization !== 'lloom-canonical-json-v1') {
    return { ...result, error: `unsupported signature canonicalization ${signature.canonicalization}` };
  }
  if (!signature?.signature) return { ...result, error: 'signature is missing signature' };
  if (!publicKey) return { ...result, error: `no public key available for ${keyId}` };
  try {
    const verified = crypto.verify(null, payload, publicKey, Buffer.from(signature.signature, 'base64'));
    return {
      ...result,
      verified,
      error: verified ? undefined : 'signature verification failed'
    };
  } catch (error) {
    return {
      ...result,
      error: error?.message ?? String(error)
    };
  }
}

function verifyRecipePackSignatures(pack, { trustedKeys = [], requireSignature = false } = {}) {
  const trustedKeyById = new Map(asArray(trustedKeys).map((key) => [key.keyId, key.publicKey]));
  const signatures = asArray(pack.signatures);
  const results = signatures.map((signature) =>
    verifySignature(signature, recipePackSigningPayload(pack), trustedKeyById)
  );
  const verified = results.some((result) => result.verified);
  const trusted = results.some((result) => result.verified && result.trusted);
  const trustRequired = trustedKeyById.size > 0;
  const errors = [];
  if (requireSignature && !signatures.length) errors.push('recipe pack requires a signature');
  if (signatures.length && !verified) errors.push('recipe pack has signatures but none verified');
  if (trustRequired && !trusted) errors.push('recipe pack is not signed by a trusted key');
  return {
    required: requireSignature,
    trustRequired,
    signed: signatures.length > 0,
    verified,
    trusted,
    accepted: trustRequired ? trusted : requireSignature ? verified : true,
    signatures: results,
    validationErrors: errors
  };
}

async function buildRecipePackPlan(
  source,
  config,
  {
    indexPath = defaultRecipeIndexPath,
    recipesRoot = defaultRecipesRoot,
    benchmarksRoot = defaultBenchmarksRoot,
    trustedKeys = [],
    requireSignature = false
  } = {}
) {
  const pack = typeof source === 'string' ? await loadRecipePack(source) : source;
  const normalizedTrustedKeys = await loadTrustedKeys(trustedKeys);
  const signature = verifyRecipePackSignatures(pack, {
    trustedKeys: normalizedTrustedKeys,
    requireSignature
  });
  const catalog = await loadBackendCatalog();
  const knownBackendIds = catalogBackendIds(catalog);
  const index = await existingIndex(indexPath);
  const validationErrors = [];
  validationErrors.push(...signature.validationErrors);
  if (pack.schemaVersion !== 1) validationErrors.push('recipe pack schemaVersion must be 1');
  if (!pack.id) validationErrors.push('recipe pack is missing id');
  if (!Array.isArray(pack.recipes)) validationErrors.push('recipe pack recipes must be an array');

  const entries = [];
  const recipeActions = [];
  const benchmarkActions = [];
  for (const [entryIndex, entry] of asArray(pack.recipes).entries()) {
    const { index: indexEntry, errors } = validatePackEntry(entry, config, knownBackendIds);
    validationErrors.push(...errors.map((error) => `recipes[${entryIndex}]: ${error}`));
    if (!entry.recipe || !indexEntry.id || !indexEntry.path) continue;

    const recipeFilePath = resolveInside(recipesRoot, indexEntry.path, `recipe pack entry ${indexEntry.id}`);
    const recipeContent = jsonString(entry.recipe);
    entries.push(indexEntry);
    recipeActions.push({
      type: 'recipe',
      id: indexEntry.id,
      path: recipeFilePath,
      relativePath: indexEntry.path,
      status: await fileStatus(recipeFilePath, recipeContent),
      content: recipeContent
    });

    for (const suite of asArray(entry.benchmarks)) {
      const fileName = safeJsonFileName(suite.fileName ?? suite.id ?? `${indexEntry.id}-benchmark`);
      const benchmarkPath = resolveInside(benchmarksRoot, fileName, `benchmark suite ${suite.id ?? indexEntry.id}`);
      const benchmarkContent = jsonString(suite);
      benchmarkActions.push({
        type: 'benchmark',
        id: suite.id ?? fileName.replace(/\.json$/, ''),
        path: benchmarkPath,
        relativePath: fileName,
        status: await fileStatus(benchmarkPath, benchmarkContent),
        content: benchmarkContent
      });
    }
  }

  const mergedIndex = mergeIndex(index, entries, pack.updatedAt);
  const indexValidationErrors = validateRecipeIndex(mergedIndex);
  validationErrors.push(...indexValidationErrors.map((error) => `index: ${error}`));
  const indexContent = jsonString({
    ...mergedIndex,
    filePath: undefined
  });
  const actions = [
    {
      type: 'index',
      id: mergedIndex.id,
      path: path.resolve(indexPath),
      status: await fileStatus(indexPath, indexContent),
      content: indexContent
    },
    ...recipeActions,
    ...benchmarkActions
  ];

  return {
    ok: validationErrors.length === 0,
    source: pack.source ?? null,
    pack: {
      id: pack.id ?? null,
      name: pack.name ?? null,
      schemaVersion: pack.schemaVersion ?? null,
      recipeCount: asArray(pack.recipes).length,
      benchmarkCount: benchmarkActions.length
    },
    recipes: asArray(pack.recipes)
      .map((entry) => ({
        id: entry?.index?.id ?? entry?.recipe?.id ?? null,
        name: entry?.index?.name ?? entry?.recipe?.name ?? null,
        path: entry?.index?.path ?? null,
        recipe: entry?.recipe ?? null,
        benchmarks: asArray(entry?.benchmarks)
      }))
      .filter((entry) => entry.id && entry.recipe),
    signature,
    roots: {
      indexPath: path.resolve(indexPath),
      recipesRoot: path.resolve(recipesRoot),
      benchmarksRoot: path.resolve(benchmarksRoot)
    },
    validationErrors,
    actions: actions.map(({ content: _content, ...action }) => action),
    writableActions: actions
  };
}

export async function createRecipePackPlan(source, config, options = {}) {
  const { writableActions: _writableActions, ...plan } = await buildRecipePackPlan(source, config, options);
  return plan;
}

export function createRecipePackSubmissionResponse({
  accepted,
  persisted = false,
  validationErrors = [],
  submissions = [],
  message,
  host,
  submittedAt = new Date().toISOString()
} = {}) {
  return {
    $schema: RECIPE_PACK_SUBMISSION_RESPONSE_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: `recipe-pack-submission-${submittedAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '')}`,
    accepted: Boolean(accepted),
    persisted: Boolean(persisted),
    count: submissions.length,
    submittedAt,
    ...(host ? { host } : {}),
    validationErrors: asArray(validationErrors),
    submissions: asArray(submissions),
    ...(message ? { message } : {})
  };
}

export function validateRecipePackSubmissionResponse(response) {
  const errors = [];
  if (response.schemaVersion !== 1) errors.push('recipe pack submission response schemaVersion must be 1');
  if (response.$schema && response.$schema !== RECIPE_PACK_SUBMISSION_RESPONSE_SCHEMA) {
    errors.push(`recipe pack submission response has unsupported $schema ${response.$schema}`);
  }
  if (!response.id) errors.push('recipe pack submission response is missing id');
  if (typeof response.accepted !== 'boolean')
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} accepted must be boolean`);
  if (typeof response.persisted !== 'boolean')
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} persisted must be boolean`);
  if (!response.submittedAt)
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} is missing submittedAt`);
  if (!Number.isInteger(response.count) || response.count < 0) {
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} count must be a non-negative integer`);
  }
  if (!Array.isArray(response.validationErrors)) {
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} validationErrors must be an array`);
  }
  if (!Array.isArray(response.submissions)) {
    errors.push(`recipe pack submission response ${response.id ?? '(missing)'} submissions must be an array`);
  }
  for (const [index, submission] of asArray(response.submissions).entries()) {
    if (!Object.hasOwn(submission ?? {}, 'id'))
      errors.push(`recipe pack submission response submissions[${index}] is missing id`);
    if (!submission?.status) errors.push(`recipe pack submission response submissions[${index}] is missing status`);
  }
  return errors;
}

export async function createRecipePackSubmissionPlan(source, config, options = {}) {
  const effective = recipePackSubmissionOptions(config, options);
  const loaded = await readRecipePackSubmission(source);
  const plan = await createRecipePackPlan(loaded.pack, config, effective);
  const requestUrl = submissionUrl(effective);
  return {
    ok: plan.ok,
    dryRun: true,
    source: loaded.source,
    host: {
      url: effective.hostUrl,
      submissionPath: effective.submissionPath,
      requestUrl
    },
    request: {
      mediaType: RECIPE_PACK_MEDIA_TYPE,
      bodyShape: 'recipe-pack.v1'
    },
    pack: plan.pack,
    signature: plan.signature,
    validationErrors: plan.validationErrors,
    actions: plan.actions,
    next: {
      submitApply: 'lloom recipe-submit <pack.json> --apply --yes'
    }
  };
}

export async function submitRecipePack(source, config, { dryRun = true, yes = false, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to submit recipe pack without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  const effective = recipePackSubmissionOptions(config, options);
  const loaded = await readRecipePackSubmission(source);
  const plan = await createRecipePackSubmissionPlan(loaded.pack, config, effective);
  if (dryRun || plan.validationErrors.length) return plan;

  const response = await fetch(plan.host.requestUrl, {
    method: 'POST',
    headers: {
      accept: `${RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE}, application/json`,
      'content-type': RECIPE_PACK_MEDIA_TYPE
    },
    body: JSON.stringify(loaded.pack),
    signal: AbortSignal.timeout(effective.timeoutMs)
  });
  const rawResponse = await response.text();
  // eslint-disable-next-line no-useless-assignment
  let body = null;
  try {
    body = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    body = { message: rawResponse };
  }
  const responseValidationErrors =
    body && typeof body === 'object'
      ? validateRecipePackSubmissionResponse(body)
      : ['recipe pack submission response must be a JSON object'];
  return {
    ...plan,
    ok: response.ok && responseValidationErrors.length === 0 && body?.accepted !== false,
    dryRun: false,
    submitted: response.ok,
    status: response.status,
    response: body,
    validationErrors: responseValidationErrors
  };
}

export async function applyRecipePack(source, config, { dryRun = true, yes = false, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to import recipe pack without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  const plan = await buildRecipePackPlan(source, config, options);
  if (!plan.ok) {
    throw new Error(`Recipe pack is invalid:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`);
  }
  if (dryRun) {
    return {
      ...plan,
      dryRun: true,
      writableActions: undefined
    };
  }

  const results = [];
  for (const action of plan.writableActions) {
    await fs.mkdir(path.dirname(action.path), { recursive: true });
    await fs.writeFile(action.path, action.content);
    results.push({
      type: action.type,
      id: action.id,
      path: action.path,
      status: action.status === 'current' ? 'unchanged' : 'written',
      previousStatus: action.status
    });
  }

  return {
    ...plan,
    dryRun: false,
    writableActions: undefined,
    results
  };
}
