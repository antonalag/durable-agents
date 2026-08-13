export type DurableErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'LOOP_DETECTED'
  | 'RUN_TERMINATED'
  | 'STORE_ERROR'
  | 'INVALID_CONFIG'
  | 'DASHBOARD_PORT_IN_USE';

export class DurableError extends Error {
  readonly code: DurableErrorCode;
  override readonly cause?: Error;

  constructor(code: DurableErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'DurableError';
    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  toJSON(): { code: string; message: string; cause?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.cause ? { cause: this.cause.message } : {}),
    };
  }
}
