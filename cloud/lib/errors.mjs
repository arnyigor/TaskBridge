// Consistent error envelope (§93).

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'TASK_NOT_FOUND',
  'MACHINE_NOT_FOUND',
  'MACHINE_OFFLINE',
  'COMMAND_REJECTED',
  'TASK_ALREADY_FINISHED',
  'APPROVAL_NOT_FOUND',
  'INVALID_STATE',
  'INPUT_INVALID',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR'
];

const STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TASK_NOT_FOUND: 404,
  MACHINE_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  NOT_FOUND: 404,
  MACHINE_OFFLINE: 409,
  COMMAND_REJECTED: 400,
  TASK_ALREADY_FINISHED: 409,
  INVALID_STATE: 409,
  INPUT_INVALID: 400,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500
};

export class CloudError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'CloudError';
    this.code = code;
    this.details = details;
  }

  get status() {
    return STATUS_BY_CODE[this.code] || 500;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details ?? {} } };
  }
}

export function errorBody(error) {
  if (error instanceof CloudError) return { status: error.status, body: error.toJSON() };
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: error?.message || 'Internal error', details: {} } }
  };
}
