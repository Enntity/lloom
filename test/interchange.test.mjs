import assert from 'node:assert/strict';
import { createErrorResponse, createInterchangeRegistry, validateInterchangeDocument } from '../src/interchange.mjs';

const config = {
  community: {
    requireSignedPacks: false
  }
};

const registry = createInterchangeRegistry();
assert.equal(registry.schemaVersion, 1);
assert(Array.isArray(registry.documents) || Array.isArray(registry.schemas) || registry.profile);
const registryValidation = await validateInterchangeDocument(registry, config);
assert.equal(registryValidation.ok, true, JSON.stringify(registryValidation.validationErrors ?? registryValidation));

const errorResponse = createErrorResponse({
  code: 'not_found',
  message: 'missing',
  status: 404
});
const errorValidation = await validateInterchangeDocument(errorResponse, config);
assert.equal(errorValidation.ok, true, JSON.stringify(errorValidation.validationErrors ?? errorValidation));

console.log('interchange tests passed');
