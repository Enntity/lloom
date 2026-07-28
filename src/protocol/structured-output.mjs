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

export function prepareStructuredOutputForBackend(body = {}, resolved = {}) {
  const contract = isObject(body.lloom) ? body.lloom.outputSchema : null;
  if (contract == null) return { body, output: null };

  const next = withoutOutputSchemaExtension(body);
  if (!isObject(contract) || !isObject(contract.schema)) {
    throw new StructuredOutputError('lloom.outputSchema.schema must be a JSON Schema object');
  }

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
    body: next,
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
