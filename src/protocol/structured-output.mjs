export class StructuredOutputError extends Error {
  constructor(message, code = 'invalid_structured_output', statusCode = 400) {
    super(message);
    this.name = 'StructuredOutputError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function withoutOutputSchemaExtension(body) {
  if (!isObject(body.lloom) || !Object.hasOwn(body.lloom, 'outputSchema')) return body;
  const { outputSchema: _outputSchema, ...remaining } = body.lloom;
  const next = { ...body };
  if (Object.keys(remaining).length) next.lloom = remaining;
  else delete next.lloom;
  return next;
}

/**
 * Translate LLooM's stable output contract into the selected backend protocol.
 *
 * Backend behavior is explicit configuration, never inferred from model names,
 * prompt language, or provider URLs.
 */
function supportsTools(resolved = {}) {
  return (
    resolved.model?.supportsTools === true ||
    (Array.isArray(resolved.model?.capabilities) && resolved.model.capabilities.includes('tools'))
  );
}

function prepareToolChoiceForBackend(body, resolved) {
  if (resolved.backend?.toolChoiceRequiresNonThinking !== true) return body;
  const forced = body.tool_choice === 'required' || body.tool_choice?.type === 'function';
  // A forced non-thinking call has no reasoning to replay. Keep that tool
  // turn non-thinking rather than inventing reasoning or triggering provider 400s.
  const messages = body.messages ?? [];
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const missingToolReasoning = messages
    .slice(lastUser + 1)
    .some((message) => message.role === 'assistant' && message.tool_calls?.length && !message.reasoning_content);
  if (!forced && !missingToolReasoning) return body;
  // Some providers reject forced tools in thinking mode. Preserve the caller's
  // tool constraint, including the tool synthesized for a schema-bound result.
  return { ...body, thinking: { ...(isObject(body.thinking) ? body.thinking : {}), type: 'disabled' } };
}

// JSON Schema's `type` keyword. A caller that writes `type: "invalid"` is
// asking for a constraint that cannot be compiled, and a backend that ignores
// it answers as if the request were unconstrained — the caller gets a 200 and
// silently loses the guarantee they asked for.
const JSON_SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

function childSchemas(node) {
  const children = [];
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
    if (isObject(node[key])) children.push([`${key}`, node[key]]);
  }
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
    if (isObject(node[key])) {
      for (const [name, child] of Object.entries(node[key])) {
        if (isObject(child)) children.push([`${key}.${name}`, child]);
      }
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(node[key])) {
      node[key].forEach((child, index) => {
        if (isObject(child)) children.push([`${key}[${index}]`, child]);
      });
    }
  }
  return children;
}

/**
 * Reject a schema no JSON Schema implementation could compile.
 *
 * Deliberately conservative: `$ref`, `enum`, `const`, `format`, unknown
 * keywords and any other construct a valid schema may carry are left alone.
 * Only a `type` that is not one of the seven JSON Schema types is refused, at
 * the root or anywhere the specification places a subschema.
 */
export function assertCompilableSchema(schema, label = 'response_format.json_schema.schema') {
  const visit = (node, path, depth) => {
    if (depth > 32) return;
    if (Object.hasOwn(node, 'type')) {
      const value = node.type;
      const values = Array.isArray(value) ? value : [value];
      if (!values.length || values.some((item) => typeof item !== 'string' || !JSON_SCHEMA_TYPES.has(item))) {
        throw new StructuredOutputError(
          `${label}${path}: "type" must be one of ${[...JSON_SCHEMA_TYPES].join(', ')}`,
          'invalid_json_schema'
        );
      }
    }
    for (const [step, child] of childSchemas(node)) visit(child, `${path}.${step}`, depth + 1);
  };
  visit(schema, '', 0);
  return schema;
}

function validateCallerResponseFormat(body) {
  const format = body.response_format;
  if (format == null) return;
  if (!isObject(format)) {
    throw new StructuredOutputError('response_format must be an object', 'invalid_response_format');
  }
  if (format.type !== 'json_schema') return;
  if (!isObject(format.json_schema)) {
    throw new StructuredOutputError('response_format.json_schema must be an object', 'invalid_json_schema');
  }
  const { schema } = format.json_schema;
  if (schema != null) {
    if (!isObject(schema)) {
      throw new StructuredOutputError(
        'response_format.json_schema.schema must be a JSON Schema object',
        'invalid_json_schema'
      );
    }
    assertCompilableSchema(schema);
  }
}

export function prepareStructuredOutputForBackend(body = {}, resolved = {}) {
  validateCallerResponseFormat(body);
  const contract = isObject(body.lloom) ? body.lloom.outputSchema : null;
  if (contract == null) return { body: prepareToolChoiceForBackend(body, resolved), output: null };

  const next = withoutOutputSchemaExtension(body);
  if (!isObject(contract) || !isObject(contract.schema)) {
    throw new StructuredOutputError('lloom.outputSchema.schema must be a JSON Schema object');
  }
  assertCompilableSchema(contract.schema, 'lloom.outputSchema.schema');

  const name = typeof contract.name === 'string' && contract.name.trim() ? contract.name.trim() : 'structured_output';
  const settings = isObject(resolved.backend?.structuredOutput) ? resolved.backend.structuredOutput : {};
  if (settings.enabled === false) {
    throw new StructuredOutputError(
      `model ${resolved.requestedId ?? resolved.model?.id ?? '(unknown)'} does not enable structured output`,
      'structured_output_unsupported'
    );
  }

  if (next.response_format != null) {
    throw new StructuredOutputError(
      'use either lloom.outputSchema or response_format, not both',
      'structured_output_conflict'
    );
  }

  if (body.stream === true) {
    throw new StructuredOutputError(
      'lloom.outputSchema currently requires stream: false',
      'structured_output_streaming'
    );
  }

  const adapter = settings.adapter ?? (supportsTools(resolved) ? 'tool' : 'json-schema');
  if (adapter === 'tool') {
    if (Array.isArray(next.tools) && next.tools.length) {
      throw new StructuredOutputError(
        'lloom.outputSchema cannot be combined with caller tools',
        'structured_output_tool_conflict'
      );
    }
    next.tools = [
      {
        type: 'function',
        function: {
          name,
          description: 'Return the schema-bound result.',
          parameters: contract.schema
        }
      }
    ];
    next.tool_choice = {
      type: 'function',
      function: { name }
    };
  } else if (adapter === 'json-schema') {
    next.response_format = {
      type: 'json_schema',
      json_schema: {
        name,
        strict: contract.strict !== false,
        schema: contract.schema
      }
    };
  } else {
    throw new StructuredOutputError(
      `unsupported structured-output adapter: ${adapter}`,
      'structured_output_adapter_invalid'
    );
  }

  if (settings.requireParameters === true) {
    next.provider = {
      ...(isObject(next.provider) ? next.provider : {}),
      require_parameters: true
    };
  }
  return {
    body: prepareToolChoiceForBackend(next, resolved),
    output: {
      adapter,
      name
    }
  };
}

export function translateStructuredOutputForBackend(body = {}, resolved = {}) {
  return prepareStructuredOutputForBackend(body, resolved).body;
}

export function normalizeStructuredOutputChatCompletion(response, output) {
  if (!output || output.adapter !== 'tool') return response;
  if (!isObject(response) || !Array.isArray(response.choices)) return response;

  let matched = false;
  const choices = response.choices.map((choice) => {
    const message = isObject(choice?.message) ? choice.message : null;
    const toolCall = Array.isArray(message?.tool_calls)
      ? message.tool_calls.find((call) => call?.function?.name === output.name)
      : null;
    if (!toolCall) {
      if (typeof message?.content === 'string' && message.content.trim()) {
        try {
          JSON.parse(message.content);
          matched = true;
        } catch {
          // The caller still receives a gateway error below.
        }
      }
      return choice;
    }
    const argumentsText =
      typeof toolCall.function?.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function?.arguments ?? {});
    try {
      JSON.parse(argumentsText);
    } catch {
      throw new StructuredOutputError(
        `backend returned invalid JSON arguments for ${output.name}`,
        'structured_output_backend_invalid',
        502
      );
    }
    matched = true;
    const { tool_calls: _toolCalls, ...remainingMessage } = message;
    return {
      ...choice,
      message: {
        ...remainingMessage,
        content: argumentsText
      },
      finish_reason: 'stop'
    };
  });

  if (!matched) {
    throw new StructuredOutputError(
      `backend did not return the required ${output.name} result`,
      'structured_output_backend_missing',
      502
    );
  }
  return { ...response, choices };
}
