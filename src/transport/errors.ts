export class TransportError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.cause = cause;
  }
}

export function createTransportError(
  code: string,
  message: string,
  cause?: unknown
): TransportError {
  return new TransportError(code, message, cause);
}
