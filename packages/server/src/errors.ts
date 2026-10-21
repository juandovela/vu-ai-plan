import type { ErrorResponse } from '@aivu/core';
import { CONTRACT_VERSION } from '@aivu/core';

export type ErrorCode = ErrorResponse['error']['code'];

/** An error with the status and contract code it answers with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const errorBody = (code: ErrorCode, message: string): ErrorResponse => ({
  contractVersion: CONTRACT_VERSION,
  error: { code, message }
});
