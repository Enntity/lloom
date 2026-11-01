export class MessengerError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = "MessengerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details = null) {
  throw new MessengerError(code, message, status, details);
}

export function asPublicError(error) {
  if (error instanceof MessengerError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      }
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } }
  };
}
