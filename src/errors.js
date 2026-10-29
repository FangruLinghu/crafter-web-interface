export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function safeMessage(error) {
  return error instanceof HttpError ? error.message : 'The operation could not be completed. Please retry or contact the server administrator.';
}
