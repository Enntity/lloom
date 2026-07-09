import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKEND_CATALOG_SCHEMA, backendIds, loadBackendCatalog, validateBackendCatalog } from './backend-catalog.mjs';
import {
  BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  BENCHMARK_SUBMISSION_RESPONSE_SCHEMA,
  BENCHMARK_SUITE_MEDIA_TYPE,
  BENCHMARK_SUITE_SCHEMA,
  validateBenchmarkSubmissionResponse,
  validateBenchmarkSuite
} from './benchmarks.mjs';
import {
  CLIENT_INTEGRATIONS_MEDIA_TYPE,
  CLIENT_INTEGRATIONS_SCHEMA,
  validateClientIntegrationManifest
} from './client-integrations.mjs';
import {
  MACHINE_PROFILE_MEDIA_TYPE,
  MACHINE_PROFILE_SCHEMA,
  RECOMMENDATION_REQUEST_MEDIA_TYPE,
  RECOMMENDATION_REQUEST_SCHEMA,
  RECOMMENDATION_RESPONSE_MEDIA_TYPE,
  RECOMMENDATION_RESPONSE_SCHEMA,
  validateMachineProfile,
  validateRecommendationRequest,
  validateRecommendationResponse
} from './machine-profile.mjs';
import { createRecipePackPlan } from './recipe-pack.mjs';
import {
  RECIPE_PACK_MEDIA_TYPE,
  RECIPE_PACK_SCHEMA,
  RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  RECIPE_PACK_SUBMISSION_RESPONSE_SCHEMA,
  validateRecipePackSubmissionResponse
} from './recipe-pack.mjs';
import { validateRecipeIndex } from './recipe-index.mjs';
import { RECIPE_SCHEMA, validateRecipe } from './recipes.mjs';

export const INTERCHANGE_REGISTRY_SCHEMA = 'https://lloom.dev/schemas/interchange-registry.v1.schema.json';
export const INTERCHANGE_REGISTRY_MEDIA_TYPE = 'application/vnd.lloom.interchange-registry+json;version=1';
export const INTERCHANGE_PROFILE = 'https://lloom.dev/profiles/interchange/v1';
export const ERROR_RESPONSE_SCHEMA = 'https://lloom.dev/schemas/error-response.v1.schema.json';
export const ERROR_RESPONSE_MEDIA_TYPE = 'application/vnd.lloom.error-response+json;version=1';
export const VALIDATION_REPORT_SCHEMA = 'https://lloom.dev/schemas/validation-report.v1.schema.json';
export const VALIDATION_REPORT_MEDIA_TYPE = 'application/vnd.lloom.validation-report+json;version=1';
export const SIGNING_KEYS_SCHEMA = 'https://lloom.dev/schemas/signing-keys.v1.schema.json';
export const SIGNING_KEYS_MEDIA_TYPE = 'application/vnd.lloom.signing-keys+json;version=1';

export const INTERCHANGE_SCHEMAS = {
  interchangeRegistry: INTERCHANGE_REGISTRY_SCHEMA,
  backendCatalog: BACKEND_CATALOG_SCHEMA,
  clientIntegrations: CLIENT_INTEGRATIONS_SCHEMA,
  machineProfile: MACHINE_PROFILE_SCHEMA,
  recommendationRequest: RECOMMENDATION_REQUEST_SCHEMA,
  recommendationResponse: RECOMMENDATION_RESPONSE_SCHEMA,
  recipe: RECIPE_SCHEMA,
  recipeIndex: 'https://lloom.dev/schemas/recipe-index.v1.schema.json',
  benchmarkSuite: BENCHMARK_SUITE_SCHEMA,
  benchmarkSubmissionResponse: BENCHMARK_SUBMISSION_RESPONSE_SCHEMA,
  recipePack: RECIPE_PACK_SCHEMA,
  recipePackSubmissionResponse: RECIPE_PACK_SUBMISSION_RESPONSE_SCHEMA,
  signingKeys: SIGNING_KEYS_SCHEMA,
  errorResponse: ERROR_RESPONSE_SCHEMA,
  validationReport: VALIDATION_REPORT_SCHEMA
};

export const INTERCHANGE_MEDIA_TYPES = {
  interchangeRegistry: INTERCHANGE_REGISTRY_MEDIA_TYPE,
  backendCatalog: 'application/vnd.lloom.backend-catalog+json;version=1',
  clientIntegrations: CLIENT_INTEGRATIONS_MEDIA_TYPE,
  machineProfile: MACHINE_PROFILE_MEDIA_TYPE,
  recommendationRequest: RECOMMENDATION_REQUEST_MEDIA_TYPE,
  recommendationResponse: RECOMMENDATION_RESPONSE_MEDIA_TYPE,
  recipe: 'application/vnd.lloom.recipe+json;version=1',
  recipeIndex: 'application/vnd.lloom.recipe-index+json;version=1',
  benchmarkSuite: BENCHMARK_SUITE_MEDIA_TYPE,
  benchmarkSubmissionResponse: BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  recipePack: RECIPE_PACK_MEDIA_TYPE,
  recipePackSubmissionResponse: RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  signingKeys: SIGNING_KEYS_MEDIA_TYPE,
  errorResponse: ERROR_RESPONSE_MEDIA_TYPE,
  validationReport: VALIDATION_REPORT_MEDIA_TYPE
};

export const INTERCHANGE_CONFORMANCE = {
  profile: INTERCHANGE_PROFILE,
  specVersion: '1.0.0',
  schemaFamily: 'https://lloom.dev/schemas/',
  extensionPrefix: 'x-',
  extensionPolicy: 'https://lloom.dev/profiles/extensions/v1',
  canonicalization: 'lloom-canonical-json-v1',
  signatureAlgorithm: 'ed25519',
  status: 'draft-stable-v1',
  conformanceLevels: ['parse', 'validate', 'publish'],
  defaultConformanceLevel: 'validate',
  contentNegotiation:
    'Prefer registered application/vnd.lloom.*+json media types with version=1; application/json is tolerated for local development.',
  compatibility: {
    additiveFields: 'minor-compatible',
    removalOrMeaningChange: 'major-version-only',
    extensions: 'x-* fields are preserved by conforming consumers',
    errorResponses: 'error-response.v1 is safe for any non-2xx response from public LLooM interchange endpoints',
    validationReports: 'validation-report.v1 is the stable automation contract for validator and CI output'
  }
};

const KNOWN_FIELDS = {
  interchangeRegistry: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'conformance',
    'documents',
    'endpoints'
  ]),
  backendCatalog: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'backends'
  ]),
  clientIntegrations: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'provider',
    'clients',
    'models'
  ]),
  machineProfile: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'platform',
    'arch',
    'platformId',
    'cpuBrand',
    'totalMemoryGb',
    'logicalCpus',
    'accelerators',
    'devices',
    'isAppleSilicon'
  ]),
  recommendationRequest: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'machineProfile',
    'request',
    'limit'
  ]),
  recommendationResponse: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'machineProfile',
    'recommendationCount',
    'request',
    'recommendations'
  ]),
  recipe: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'version',
    'summary',
    'description',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'keywords',
    'capabilities',
    'hardware',
    'requirements',
    'backend',
    'setup',
    'models'
  ]),
  recipeIndex: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'keywords',
    'recipes'
  ]),
  benchmarkSuite: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'source',
    'createdAt',
    'submittedAt',
    'updatedAt',
    'provenance',
    'links',
    'methodology',
    'results'
  ]),
  benchmarkSubmissionResponse: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'accepted',
    'persisted',
    'count',
    'submittedAt',
    'host',
    'validationErrors',
    'submissions',
    'message'
  ]),
  recipePack: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'license',
    'publisher',
    'createdAt',
    'updatedAt',
    'provenance',
    'links',
    'keywords',
    'dependencies',
    'recipes',
    'signatures'
  ]),
  recipePackSubmissionResponse: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'accepted',
    'persisted',
    'count',
    'submittedAt',
    'host',
    'validationErrors',
    'submissions',
    'message'
  ]),
  signingKeys: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'name',
    'summary',
    'updatedAt',
    'publisher',
    'provenance',
    'links',
    'data'
  ]),
  errorResponse: new Set(['$schema', 'schemaVersion', 'profile', 'id', 'occurredAt', 'host', 'error']),
  validationReport: new Set([
    '$schema',
    'schemaVersion',
    'profile',
    'id',
    'source',
    'validatedAt',
    'ok',
    'kind',
    'schema',
    'mediaType',
    'conformance',
    'conformanceLevel',
    'conformanceWarnings',
    'validationErrors',
    'signature',
    'pack',
    'actions'
  ])
};

const INTERCHANGE_DOCUMENTS = [
  {
    kind: 'interchangeRegistry',
    name: 'Interchange Registry',
    description: 'Machine-readable registry of LLooM v1 schemas, media types, endpoints, and extension policy.',
    conformanceLevel: 'publish'
  },
  {
    kind: 'backendCatalog',
    name: 'Backend Catalog',
    description: 'Runtime-family metadata that recipes can target.'
  },
  {
    kind: 'clientIntegrations',
    name: 'Client Integrations',
    description: 'Discovery metadata for local gateway clients and generated integration artifacts.'
  },
  {
    kind: 'machineProfile',
    name: 'Machine Profile',
    description: 'Portable hardware profile used for recipe matching.'
  },
  {
    kind: 'recommendationRequest',
    name: 'Recommendation Request',
    description: 'Hosted recommendation request containing a machine profile and optional workload/capability intent.'
  },
  {
    kind: 'recommendationResponse',
    name: 'Recommendation Response',
    description: 'Hosted recommendation response for a submitted machine profile.'
  },
  {
    kind: 'recipe',
    name: 'Recipe',
    description: 'One portable backend/model setup recipe.'
  },
  {
    kind: 'recipeIndex',
    name: 'Recipe Index',
    description: 'Searchable list of recipe entries.'
  },
  {
    kind: 'benchmarkSuite',
    name: 'Benchmark Suite',
    description: 'Measured model/backend evidence with methodology and workload metadata.'
  },
  {
    kind: 'benchmarkSubmissionResponse',
    name: 'Benchmark Submission Response',
    description: 'Portable receipt returned by benchmark submission endpoints.'
  },
  {
    kind: 'recipePack',
    name: 'Recipe Pack',
    description: 'Bundle containing recipe index metadata, recipes, benchmark suites, and optional signatures.'
  },
  {
    kind: 'recipePackSubmissionResponse',
    name: 'Recipe Pack Submission Response',
    description: 'Portable receipt returned by recipe-pack submission endpoints.'
  },
  {
    kind: 'signingKeys',
    name: 'Signing Keys',
    description: 'Public Ed25519 keys used to verify LLooM recipe-pack and recommendation-feed signatures.',
    conformanceLevel: 'publish'
  },
  {
    kind: 'errorResponse',
    name: 'Error Response',
    description: 'Portable non-2xx error body for LLooM-compatible public endpoints.',
    conformanceLevel: 'validate'
  },
  {
    kind: 'validationReport',
    name: 'Validation Report',
    description: 'Portable conformance result returned by LLooM-compatible validators and CI checks.',
    conformanceLevel: 'publish'
  }
];

const INTERCHANGE_ENDPOINTS = [
  {
    method: 'GET',
    path: '/v1/interchange',
    responseKind: 'interchangeRegistry',
    successStatus: 200,
    description: 'Discover the LLooM v1 interchange registry.'
  },
  {
    method: 'GET',
    path: '/.well-known/lloom-interchange',
    responseKind: 'interchangeRegistry',
    successStatus: 200,
    description: 'Well-known discovery alias for the LLooM v1 interchange registry.'
  },
  {
    method: 'GET',
    path: '/v1/backends/catalog',
    responseKind: 'backendCatalog',
    successStatus: 200,
    description: 'Fetch the portable backend catalog with setup actions, server contracts, and supported platforms.'
  },
  {
    method: 'GET',
    path: '/v1/backends',
    successStatus: 200,
    description: 'Fetch a lightweight searchable backend-family index from this host.',
    'x-responseKind': 'backendSummaryList'
  },
  {
    method: 'GET',
    path: '/v1/keys',
    responseKind: 'signingKeys',
    successStatus: 200,
    description: 'Fetch active public signing keys for recipe-pack and recommendation-feed verification.'
  },
  {
    method: 'GET',
    path: '/v1/recipes',
    successStatus: 200,
    description: 'Search recipe metadata available from this host.',
    queryParameters: ['q', 'query', 'tag', 'capability', 'platform'],
    'x-responseKind': 'recipeSearchResults'
  },
  {
    method: 'GET',
    path: '/v1/leaderboard',
    successStatus: 200,
    description: 'Fetch machine- and workload-filterable benchmark leaderboard rows.',
    queryParameters: ['recipe', 'recipe_id', 'backend', 'backend_id', 'model', 'platform', 'workload'],
    'x-responseKind': 'leaderboard'
  },
  {
    method: 'GET',
    path: '/v1/recipe-packs/:id',
    responseKind: 'recipePack',
    successStatus: 200,
    description: 'Fetch one recipe pack by stable ID.'
  },
  {
    method: 'GET',
    path: '/v1/recipe-packs/recommended',
    responseKind: 'recommendationResponse',
    successStatus: 200,
    description:
      'Recommend recipe packs for a submitted or query-derived machine profile and optional workload/capability intent.',
    queryParameters: ['platform', 'platform_id', 'arch', 'memory_gb', 'cpu', 'workload', 'capability', 'tag', 'limit']
  },
  {
    method: 'POST',
    path: '/v1/recipe-packs/recommended',
    requestKind: 'recommendationRequest',
    responseKind: 'recommendationResponse',
    successStatus: 200,
    idempotent: true,
    description:
      'Recommend recipe packs for a full machine-profile request document and optional workload/capability intent.'
  },
  {
    method: 'POST',
    path: '/v1/recipe-packs',
    requestKind: 'recipePack',
    responseKind: 'recipePackSubmissionResponse',
    successStatus: 202,
    idempotent: false,
    description: 'Submit a recipe pack for validation, moderation, signing, or publication.'
  },
  {
    method: 'POST',
    path: '/v1/benchmarks',
    requestKind: 'benchmarkSuite',
    responseKind: 'benchmarkSubmissionResponse',
    successStatus: 202,
    idempotent: false,
    description: 'Submit benchmark evidence for validation, moderation, and leaderboard consideration.'
  }
];

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function readJsonSource(source) {
  if (!source) throw new Error('interchange source is required');
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch interchange document ${source}: HTTP ${response.status}`);
    return {
      source,
      document: await response.json()
    };
  }
  const filePath = path.resolve(source);
  return {
    source: filePath,
    document: JSON.parse(await fs.readFile(filePath, 'utf8'))
  };
}

function kindFromSchema(schema) {
  return Object.entries(INTERCHANGE_SCHEMAS).find(([, schemaId]) => schemaId === schema)?.[0] ?? null;
}

function registryDocuments() {
  return INTERCHANGE_DOCUMENTS.map((document) => ({
    ...document,
    schema: INTERCHANGE_SCHEMAS[document.kind],
    mediaType: INTERCHANGE_MEDIA_TYPES[document.kind],
    status: 'draft-stable',
    since: '0.1.0',
    compatibility: 'minor-compatible-within-schemaVersion-1',
    conformanceLevel: document.conformanceLevel ?? 'validate'
  }));
}

function registryEndpoints() {
  return INTERCHANGE_ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    ...(endpoint.requestKind
      ? {
          requestMediaType: INTERCHANGE_MEDIA_TYPES[endpoint.requestKind],
          requestSchema: INTERCHANGE_SCHEMAS[endpoint.requestKind]
        }
      : {}),
    ...(endpoint.responseKind
      ? {
          responseMediaType: INTERCHANGE_MEDIA_TYPES[endpoint.responseKind],
          responseSchema: INTERCHANGE_SCHEMAS[endpoint.responseKind]
        }
      : {}),
    errorKind: 'errorResponse',
    errorMediaType: INTERCHANGE_MEDIA_TYPES.errorResponse,
    errorSchema: INTERCHANGE_SCHEMAS.errorResponse
  }));
}

function errorId(date = new Date()) {
  return `error-${date.toISOString().replace(/[:.]/g, '-')}`;
}

function validationReportId(date = new Date()) {
  return `validation-${date.toISOString().replace(/[:.]/g, '-')}`;
}

function createValidationReport(fields, { validatedAt = new Date().toISOString() } = {}) {
  return {
    $schema: VALIDATION_REPORT_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: validationReportId(new Date(validatedAt)),
    validatedAt,
    conformanceLevel: INTERCHANGE_CONFORMANCE.defaultConformanceLevel,
    ...fields
  };
}

export function createErrorResponse(
  message,
  {
    id,
    status,
    code = 'error',
    type,
    title,
    detail,
    validationErrors,
    host,
    occurredAt = new Date().toISOString(),
    extensions = {}
  } = {}
) {
  return {
    $schema: ERROR_RESPONSE_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: id ?? errorId(new Date(occurredAt)),
    occurredAt,
    ...(host ? { host } : {}),
    error: {
      code,
      message,
      type: type ?? `https://lloom.dev/problems/${code}`,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(Array.isArray(validationErrors) ? { validationErrors } : {}),
      ...extensions
    }
  };
}

export function validateErrorResponse(response) {
  const errors = [];
  if (!asObject(response)) return ['error response must be an object'];
  if (response.schemaVersion !== 1) errors.push('error response schemaVersion must be 1');
  if (response.$schema && response.$schema !== ERROR_RESPONSE_SCHEMA) {
    errors.push(`error response has unsupported $schema ${response.$schema}`);
  }
  if (response.profile && response.profile !== INTERCHANGE_PROFILE) {
    errors.push(`error response profile must be ${INTERCHANGE_PROFILE}`);
  }
  if (!response.id) errors.push('error response id is required');
  if (!response.error || typeof response.error !== 'object' || Array.isArray(response.error)) {
    errors.push('error response error object is required');
  } else {
    if (!response.error.code) errors.push('error response error.code is required');
    if (!response.error.message) errors.push('error response error.message is required');
    if (
      response.error.status != null &&
      (!Number.isInteger(response.error.status) || response.error.status < 100 || response.error.status > 599)
    ) {
      errors.push('error response error.status must be an HTTP status code');
    }
    if (response.error.validationErrors != null && !Array.isArray(response.error.validationErrors)) {
      errors.push('error response error.validationErrors must be an array');
    }
  }
  return errors;
}

export function validateValidationReport(report) {
  const errors = [];
  if (!asObject(report)) return ['validation report must be an object'];
  if (report.schemaVersion !== 1) errors.push('validation report schemaVersion must be 1');
  if (report.$schema && report.$schema !== VALIDATION_REPORT_SCHEMA) {
    errors.push(`validation report has unsupported $schema ${report.$schema}`);
  }
  if (report.profile && report.profile !== INTERCHANGE_PROFILE) {
    errors.push(`validation report profile must be ${INTERCHANGE_PROFILE}`);
  }
  if (!report.id) errors.push('validation report id is required');
  if (typeof report.ok !== 'boolean') errors.push('validation report ok must be boolean');
  if (!Array.isArray(report.validationErrors)) {
    errors.push('validation report validationErrors must be an array');
  }
  if (!Array.isArray(report.conformanceWarnings)) {
    errors.push('validation report conformanceWarnings must be an array');
  }
  if (!report.validatedAt) errors.push('validation report validatedAt is required');
  if (report.kind != null && !INTERCHANGE_SCHEMAS[report.kind]) {
    errors.push(`validation report kind ${report.kind} is not registered`);
  }
  if (report.kind && report.schema !== INTERCHANGE_SCHEMAS[report.kind]) {
    errors.push(`validation report schema does not match registered kind ${report.kind}`);
  }
  if (report.kind && report.mediaType !== INTERCHANGE_MEDIA_TYPES[report.kind]) {
    errors.push(`validation report mediaType does not match registered kind ${report.kind}`);
  }
  return errors;
}

export function createInterchangeRegistry({
  baseUrl = 'https://lloom.dev',
  serviceUrl,
  updatedAt = '2026-07-07T00:00:00.000Z'
} = {}) {
  const schemaBase = `${String(baseUrl).replace(/\/+$/, '')}/schemas/`;
  return {
    $schema: INTERCHANGE_REGISTRY_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: 'lloom-interchange-v1',
    name: 'LLooM Interchange Registry v1',
    summary:
      'Machine-readable registry for LLooM v1 interchange schemas, media types, endpoints, and extension policy.',
    license: 'CC-BY-4.0',
    publisher: {
      id: 'lloom',
      name: 'LLooM Project',
      url: 'https://lloom.dev'
    },
    updatedAt,
    provenance: {
      generatedBy: 'lloom',
      source: 'src/interchange.mjs'
    },
    links: [
      {
        rel: 'describedby',
        href: 'https://lloom.dev/docs/interchange',
        mediaType: 'text/markdown'
      },
      {
        rel: 'profile',
        href: INTERCHANGE_PROFILE,
        mediaType: 'text/markdown'
      },
      {
        rel: 'extension-policy',
        href: INTERCHANGE_CONFORMANCE.extensionPolicy,
        mediaType: 'text/markdown'
      },
      {
        rel: 'schemas',
        href: schemaBase
      }
    ],
    conformance: INTERCHANGE_CONFORMANCE,
    documents: registryDocuments(),
    endpoints: registryEndpoints(),
    ...(serviceUrl ? { 'x-serviceBaseUrl': String(serviceUrl).replace(/\/+$/, '') } : {})
  };
}

export function createSigningKeysDocument(
  keys = [],
  {
    id = 'lloom-signing-keys',
    name = 'LLooM Signing Keys',
    updatedAt = new Date().toISOString(),
    publisher,
    provenance
  } = {}
) {
  return {
    $schema: SIGNING_KEYS_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id,
    name,
    updatedAt,
    ...(publisher ? { publisher } : {}),
    ...(provenance ? { provenance } : {}),
    data: Array.isArray(keys) ? keys : []
  };
}

export function validateSigningKeysDocument(document) {
  const errors = [];
  if (document.schemaVersion !== 1) errors.push('signing keys schemaVersion must be 1');
  if (document.$schema && document.$schema !== SIGNING_KEYS_SCHEMA) {
    errors.push(`signing keys has unsupported $schema ${document.$schema}`);
  }
  if (document.profile && document.profile !== INTERCHANGE_PROFILE) {
    errors.push(`signing keys profile must be ${INTERCHANGE_PROFILE}`);
  }
  if (!document.id) errors.push('signing keys id is required');
  if (!Array.isArray(document.data)) {
    errors.push('signing keys data must be an array');
    return errors;
  }
  const seen = new Set();
  for (const [index, key] of document.data.entries()) {
    if (!key?.keyId) errors.push(`signing keys data[${index}] is missing keyId`);
    if (key?.keyId && seen.has(key.keyId)) errors.push(`duplicate signing key id: ${key.keyId}`);
    if (key?.keyId) seen.add(key.keyId);
    if (key?.algorithm !== 'ed25519') {
      errors.push(`signing keys data[${index}] algorithm must be ed25519`);
    }
    if (!key?.publicKey) errors.push(`signing keys data[${index}] is missing publicKey`);
    if (key?.status && !['active', 'retiring', 'retired', 'revoked'].includes(key.status)) {
      errors.push(`signing keys data[${index}] has unsupported status ${key.status}`);
    }
  }
  return errors;
}

export function validateInterchangeRegistry(registry) {
  const errors = [];
  if (registry.schemaVersion !== 1) errors.push('interchange registry schemaVersion must be 1');
  if (registry.$schema && registry.$schema !== INTERCHANGE_REGISTRY_SCHEMA) {
    errors.push(`interchange registry has unsupported $schema ${registry.$schema}`);
  }
  if (registry.profile && registry.profile !== INTERCHANGE_PROFILE) {
    errors.push(`interchange registry profile must be ${INTERCHANGE_PROFILE}`);
  }
  if (!registry.id) errors.push('interchange registry is missing id');
  if (!Array.isArray(registry.documents)) {
    errors.push('interchange registry documents must be an array');
  }
  for (const [index, document] of (Array.isArray(registry.documents) ? registry.documents : []).entries()) {
    if (!document?.kind) errors.push(`interchange registry documents[${index}] is missing kind`);
    if (!document?.schema) errors.push(`interchange registry documents[${index}] is missing schema`);
    if (!document?.mediaType) errors.push(`interchange registry documents[${index}] is missing mediaType`);
    if (
      document?.kind &&
      INTERCHANGE_SCHEMAS[document.kind] &&
      document.schema !== INTERCHANGE_SCHEMAS[document.kind]
    ) {
      errors.push(`interchange registry documents[${index}] schema does not match registered kind ${document.kind}`);
    }
    if (
      document?.kind &&
      INTERCHANGE_MEDIA_TYPES[document.kind] &&
      document.mediaType !== INTERCHANGE_MEDIA_TYPES[document.kind]
    ) {
      errors.push(`interchange registry documents[${index}] mediaType does not match registered kind ${document.kind}`);
    }
    if (document?.status && !['draft', 'draft-stable', 'stable', 'deprecated'].includes(document.status)) {
      errors.push(`interchange registry documents[${index}] has unsupported status ${document.status}`);
    }
  }
  if (!Array.isArray(registry.endpoints)) {
    errors.push('interchange registry endpoints must be an array');
  }
  for (const [index, endpoint] of (Array.isArray(registry.endpoints) ? registry.endpoints : []).entries()) {
    if (!endpoint?.method) errors.push(`interchange registry endpoints[${index}] is missing method`);
    if (!endpoint?.path) errors.push(`interchange registry endpoints[${index}] is missing path`);
    if (endpoint?.requestKind && endpoint.requestMediaType !== INTERCHANGE_MEDIA_TYPES[endpoint.requestKind]) {
      errors.push(`interchange registry endpoints[${index}] requestMediaType does not match ${endpoint.requestKind}`);
    }
    if (endpoint?.responseKind && endpoint.responseMediaType !== INTERCHANGE_MEDIA_TYPES[endpoint.responseKind]) {
      errors.push(`interchange registry endpoints[${index}] responseMediaType does not match ${endpoint.responseKind}`);
    }
    if (endpoint?.errorKind && endpoint.errorKind !== 'errorResponse') {
      errors.push(`interchange registry endpoints[${index}] errorKind must be errorResponse`);
    }
    if (endpoint?.errorMediaType && endpoint.errorMediaType !== ERROR_RESPONSE_MEDIA_TYPE) {
      errors.push(`interchange registry endpoints[${index}] errorMediaType must be ${ERROR_RESPONSE_MEDIA_TYPE}`);
    }
  }
  return errors;
}

export function detectInterchangeKind(document) {
  const object = asObject(document);
  if (!object) return null;
  const schemaKind = object.$schema ? kindFromSchema(object.$schema) : null;
  if (schemaKind) return schemaKind;
  if (Array.isArray(object.documents) && Array.isArray(object.endpoints) && object.conformance)
    return 'interchangeRegistry';
  if (Array.isArray(object.recipes) && object.recipes.some((entry) => entry?.recipe)) return 'recipePack';
  if (Array.isArray(object.recipes)) return 'recipeIndex';
  if (Array.isArray(object.backends)) return 'backendCatalog';
  if (object.provider && Array.isArray(object.models)) return 'clientIntegrations';
  if (object.machineProfile && Array.isArray(object.recommendations)) return 'recommendationResponse';
  if (object.machineProfile) return 'recommendationRequest';
  if (object.platformId && object.totalMemoryGb != null) return 'machineProfile';
  if (Array.isArray(object.data) && object.data.every((entry) => entry?.keyId && entry?.publicKey))
    return 'signingKeys';
  if (typeof object.accepted === 'boolean' && Array.isArray(object.submissions)) {
    const first = object.submissions[0] ?? {};
    return first.recipeCount != null || first.benchmarkCount != null || object.host?.endpoint === '/v1/recipe-packs'
      ? 'recipePackSubmissionResponse'
      : 'benchmarkSubmissionResponse';
  }
  if (
    typeof object.ok === 'boolean' &&
    Array.isArray(object.validationErrors) &&
    Array.isArray(object.conformanceWarnings)
  ) {
    return 'validationReport';
  }
  if (object.error?.message && object.error?.code) return 'errorResponse';
  if (Array.isArray(object.results)) return 'benchmarkSuite';
  if (object.backend && Array.isArray(object.models)) return 'recipe';
  return null;
}

function schemaErrors(document, kind) {
  const expected = INTERCHANGE_SCHEMAS[kind];
  if (!document.$schema || document.$schema === expected) return [];
  return [`${kind} has unsupported $schema ${document.$schema}; expected ${expected}`];
}

function addMissingWarning(warnings, document, field, label) {
  if (document[field] == null) warnings.push(`${label} should include ${field} for public interchange`);
}

function unknownFieldWarnings(document, kind) {
  const known = KNOWN_FIELDS[kind] ?? new Set();
  return Object.keys(document)
    .filter((key) => !known.has(key) && !key.startsWith(INTERCHANGE_CONFORMANCE.extensionPrefix))
    .map(
      (key) =>
        `${kind} custom field ${key} should use the ${INTERCHANGE_CONFORMANCE.extensionPrefix} prefix or be added to the public schema`
    );
}

function recipeWarnings(recipe) {
  const warnings = [];
  addMissingWarning(warnings, recipe, 'summary', `recipe ${recipe.id ?? '(missing)'}`);
  addMissingWarning(warnings, recipe, 'license', `recipe ${recipe.id ?? '(missing)'}`);
  addMissingWarning(warnings, recipe, 'provenance', `recipe ${recipe.id ?? '(missing)'}`);
  if (!Array.isArray(recipe.capabilities) || !recipe.capabilities.length) {
    warnings.push(`recipe ${recipe.id ?? '(missing)'} should declare portable capabilities`);
  }
  for (const [index, model] of (Array.isArray(recipe.models) ? recipe.models : []).entries()) {
    if (!Array.isArray(model.capabilities) || !model.capabilities.length) {
      warnings.push(`recipe ${recipe.id ?? '(missing)'} models[${index}] should declare model capabilities`);
    }
  }
  return warnings;
}

function benchmarkWarnings(suite) {
  const warnings = [];
  addMissingWarning(warnings, suite, 'source', `benchmark suite ${suite.id ?? '(missing)'}`);
  addMissingWarning(warnings, suite, 'license', `benchmark suite ${suite.id ?? '(missing)'}`);
  addMissingWarning(warnings, suite, 'methodology', `benchmark suite ${suite.id ?? '(missing)'}`);
  return warnings;
}

function backendCatalogWarnings(catalog) {
  const warnings = [];
  addMissingWarning(warnings, catalog, 'updatedAt', `backend catalog ${catalog.id ?? '(missing)'}`);
  addMissingWarning(warnings, catalog, 'license', `backend catalog ${catalog.id ?? '(missing)'}`);
  addMissingWarning(warnings, catalog, 'provenance', `backend catalog ${catalog.id ?? '(missing)'}`);
  for (const [index, backend] of (Array.isArray(catalog.backends) ? catalog.backends : []).entries()) {
    const label = `backend catalog ${catalog.id ?? '(missing)'} backends[${index}]`;
    addMissingWarning(warnings, backend, 'description', label);
    if (!Array.isArray(backend.features) || !backend.features.length) {
      warnings.push(`${label} should declare backend features`);
    }
    if (!backend.server?.protocol) {
      warnings.push(`${label} should declare server.protocol`);
    }
  }
  return warnings;
}

function clientIntegrationsWarnings(manifest) {
  const warnings = [];
  addMissingWarning(warnings, manifest, 'license', `client integrations ${manifest.id ?? '(missing)'}`);
  addMissingWarning(warnings, manifest, 'provenance', `client integrations ${manifest.id ?? '(missing)'}`);
  if (!manifest.provider?.gatewayUrl) {
    warnings.push(`client integrations ${manifest.id ?? '(missing)'} provider should declare gatewayUrl`);
  }
  if (!manifest.provider?.openAIBaseUrl) {
    warnings.push(`client integrations ${manifest.id ?? '(missing)'} provider should declare openAIBaseUrl`);
  }
  if (!manifest.provider?.anthropicBaseUrl) {
    warnings.push(`client integrations ${manifest.id ?? '(missing)'} provider should declare anthropicBaseUrl`);
  }
  if (!Array.isArray(manifest.provider?.protocols) || !manifest.provider.protocols.length) {
    warnings.push(`client integrations ${manifest.id ?? '(missing)'} provider should declare supported protocols`);
  }
  if (!manifest.provider?.endpoints?.chatCompletions) {
    warnings.push(`client integrations ${manifest.id ?? '(missing)'} provider should declare endpoint paths`);
  }
  for (const [index, model] of (Array.isArray(manifest.models) ? manifest.models : []).entries()) {
    const label = `client integrations ${manifest.id ?? '(missing)'} models[${index}]`;
    if (!Array.isArray(model.input) || !model.input.length) warnings.push(`${label} should declare input modalities`);
    if (!Array.isArray(model.output) || !model.output.length)
      warnings.push(`${label} should declare output modalities`);
    if (!Array.isArray(model.capabilities) || !model.capabilities.length)
      warnings.push(`${label} should declare capabilities`);
    if (model.contextWindow == null) warnings.push(`${label} should declare contextWindow`);
    if (model.maxOutputTokens == null) warnings.push(`${label} should declare maxOutputTokens`);
  }
  return warnings;
}

function machineProfileWarnings(profile) {
  const warnings = [];
  if (!Array.isArray(profile.accelerators)) {
    warnings.push(`machine profile ${profile.id ?? '(missing)'} should declare accelerators`);
  }
  if (!Array.isArray(profile.devices)) {
    warnings.push(`machine profile ${profile.id ?? '(missing)'} should declare devices`);
  }
  if (!profile.cpuBrand) {
    warnings.push(`machine profile ${profile.id ?? '(missing)'} should declare cpuBrand`);
  }
  return warnings;
}

function recommendationResponseWarnings(response) {
  const warnings = [];
  addMissingWarning(warnings, response, 'provenance', `recommendation response ${response.id ?? '(missing)'}`);
  for (const [index, recommendation] of (Array.isArray(response.recommendations)
    ? response.recommendations
    : []
  ).entries()) {
    const label = `recommendation response ${response.id ?? '(missing)'} recommendations[${index}]`;
    if (recommendation.score == null) warnings.push(`${label} should declare score`);
    if (!recommendation.evaluation) warnings.push(`${label} should include evaluation details`);
  }
  return warnings;
}

export function interchangeConformanceWarnings(document, kind = detectInterchangeKind(document)) {
  const object = asObject(document);
  if (!object || !kind) return [];
  const warnings = [];
  if (!object.$schema) warnings.push(`${kind} should include $schema`);
  if (object.profile && object.profile !== INTERCHANGE_PROFILE) {
    warnings.push(`${kind} profile ${object.profile} is not the LLooM v1 interchange profile`);
  }
  if (!object.profile) warnings.push(`${kind} should include profile ${INTERCHANGE_PROFILE}`);
  warnings.push(...unknownFieldWarnings(object, kind));

  if (kind === 'interchangeRegistry') {
    addMissingWarning(warnings, object, 'updatedAt', `interchange registry ${object.id ?? '(missing)'}`);
    if (!Array.isArray(object.documents) || !object.documents.length) {
      warnings.push(`interchange registry ${object.id ?? '(missing)'} should include documents`);
    }
    if (!Array.isArray(object.endpoints) || !object.endpoints.length) {
      warnings.push(`interchange registry ${object.id ?? '(missing)'} should include endpoints`);
    }
  } else if (kind === 'backendCatalog') {
    warnings.push(...backendCatalogWarnings(object));
  } else if (kind === 'clientIntegrations') {
    warnings.push(...clientIntegrationsWarnings(object));
  } else if (kind === 'machineProfile') {
    warnings.push(...machineProfileWarnings(object));
  } else if (kind === 'recommendationResponse') {
    warnings.push(...recommendationResponseWarnings(object));
  } else if (kind === 'recipe') {
    warnings.push(...recipeWarnings(object));
  } else if (kind === 'recipeIndex') {
    addMissingWarning(warnings, object, 'updatedAt', `recipe index ${object.id ?? '(missing)'}`);
    addMissingWarning(warnings, object, 'provenance', `recipe index ${object.id ?? '(missing)'}`);
  } else if (kind === 'benchmarkSuite') {
    warnings.push(...benchmarkWarnings(object));
  } else if (kind === 'benchmarkSubmissionResponse') {
    if (!object.host?.endpoint) {
      warnings.push(`benchmark submission response ${object.id ?? '(missing)'} should include host.endpoint`);
    }
  } else if (kind === 'recipePackSubmissionResponse') {
    if (!object.host?.endpoint) {
      warnings.push(`recipe pack submission response ${object.id ?? '(missing)'} should include host.endpoint`);
    }
  } else if (kind === 'signingKeys') {
    addMissingWarning(warnings, object, 'updatedAt', `signing keys ${object.id ?? '(missing)'}`);
    if (!Array.isArray(object.data) || !object.data.length) {
      warnings.push(`signing keys ${object.id ?? '(missing)'} should include at least one public key`);
    }
  } else if (kind === 'errorResponse') {
    if (!object.host?.endpoint) {
      warnings.push(`error response ${object.id ?? '(missing)'} should include host.endpoint`);
    }
    if (!object.error?.status) {
      warnings.push(`error response ${object.id ?? '(missing)'} should include error.status`);
    }
  } else if (kind === 'validationReport') {
    if (!object.validatedAt) {
      warnings.push(`validation report ${object.id ?? '(missing)'} should include validatedAt`);
    }
  } else if (kind === 'recipePack') {
    addMissingWarning(warnings, object, 'updatedAt', `recipe pack ${object.id ?? '(missing)'}`);
    addMissingWarning(warnings, object, 'publisher', `recipe pack ${object.id ?? '(missing)'}`);
    addMissingWarning(warnings, object, 'license', `recipe pack ${object.id ?? '(missing)'}`);
    addMissingWarning(warnings, object, 'provenance', `recipe pack ${object.id ?? '(missing)'}`);
    if (!Array.isArray(object.signatures) || !object.signatures.length) {
      warnings.push(`recipe pack ${object.id ?? '(missing)'} should be signed before publication`);
    }
    for (const [entryIndex, entry] of (Array.isArray(object.recipes) ? object.recipes : []).entries()) {
      if (entry?.recipe) {
        warnings.push(...recipeWarnings(entry.recipe).map((warning) => `recipes[${entryIndex}]: ${warning}`));
      }
      for (const [suiteIndex, suite] of (Array.isArray(entry?.benchmarks) ? entry.benchmarks : []).entries()) {
        warnings.push(
          ...benchmarkWarnings(suite).map((warning) => `recipes[${entryIndex}].benchmarks[${suiteIndex}]: ${warning}`)
        );
      }
    }
  }

  return warnings;
}

async function localBackendIds() {
  const catalog = await loadBackendCatalog();
  return backendIds(catalog);
}

export async function validateInterchangeDocument(
  document,
  config,
  { indexPath, recipesRoot, benchmarksRoot, trustedKeys = [], requireSignature = false, validatedAt } = {}
) {
  const kind = detectInterchangeKind(document);
  if (!kind) {
    return createValidationReport(
      {
        ok: false,
        kind: null,
        schema: null,
        mediaType: null,
        conformance: INTERCHANGE_CONFORMANCE,
        conformanceWarnings: [],
        validationErrors: ['unknown LLooM interchange document kind']
      },
      { validatedAt }
    );
  }

  if (kind === 'recipePack') {
    const plan = await createRecipePackPlan(document, config, {
      indexPath,
      recipesRoot,
      benchmarksRoot,
      trustedKeys,
      requireSignature
    });
    const validationErrors = [...schemaErrors(document, kind), ...plan.validationErrors];
    return createValidationReport(
      {
        ok: validationErrors.length === 0,
        kind,
        schema: INTERCHANGE_SCHEMAS[kind],
        mediaType: INTERCHANGE_MEDIA_TYPES[kind],
        conformance: INTERCHANGE_CONFORMANCE,
        conformanceWarnings: interchangeConformanceWarnings(document, kind),
        validationErrors,
        pack: plan.pack,
        signature: plan.signature,
        actions: plan.actions
      },
      { validatedAt }
    );
  }

  let validationErrors = schemaErrors(document, kind);
  if (kind === 'backendCatalog') {
    validationErrors = [...validationErrors, ...validateBackendCatalog(document)];
  } else if (kind === 'interchangeRegistry') {
    validationErrors = [...validationErrors, ...validateInterchangeRegistry(document)];
  } else if (kind === 'clientIntegrations') {
    validationErrors = [...validationErrors, ...validateClientIntegrationManifest(document)];
  } else if (kind === 'machineProfile') {
    validationErrors = [...validationErrors, ...validateMachineProfile(document)];
  } else if (kind === 'recommendationRequest') {
    validationErrors = [...validationErrors, ...validateRecommendationRequest(document)];
  } else if (kind === 'recommendationResponse') {
    validationErrors = [...validationErrors, ...validateRecommendationResponse(document)];
  } else if (kind === 'recipe') {
    validationErrors = [
      ...validationErrors,
      ...validateRecipe(document, config, {
        backendIds: await localBackendIds(),
        checkLocalReferences: false
      })
    ];
  } else if (kind === 'recipeIndex') {
    validationErrors = [...validationErrors, ...validateRecipeIndex(document)];
  } else if (kind === 'benchmarkSuite') {
    validationErrors = [...validationErrors, ...validateBenchmarkSuite(document)];
  } else if (kind === 'benchmarkSubmissionResponse') {
    validationErrors = [...validationErrors, ...validateBenchmarkSubmissionResponse(document)];
  } else if (kind === 'recipePackSubmissionResponse') {
    validationErrors = [...validationErrors, ...validateRecipePackSubmissionResponse(document)];
  } else if (kind === 'signingKeys') {
    validationErrors = [...validationErrors, ...validateSigningKeysDocument(document)];
  } else if (kind === 'errorResponse') {
    validationErrors = [...validationErrors, ...validateErrorResponse(document)];
  } else if (kind === 'validationReport') {
    validationErrors = [...validationErrors, ...validateValidationReport(document)];
  }

  return createValidationReport(
    {
      ok: validationErrors.length === 0,
      kind,
      schema: INTERCHANGE_SCHEMAS[kind],
      mediaType: INTERCHANGE_MEDIA_TYPES[kind],
      conformance: INTERCHANGE_CONFORMANCE,
      conformanceWarnings: interchangeConformanceWarnings(document, kind),
      validationErrors
    },
    { validatedAt }
  );
}

export async function createInterchangeValidationReport(source, config, options = {}) {
  const loaded = await readJsonSource(source);
  return {
    ...(await validateInterchangeDocument(loaded.document, config, options)),
    source: loaded.source
  };
}
