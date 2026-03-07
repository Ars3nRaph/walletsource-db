export enum ErrorCode {
  DB_CONNECTION_FAILED = 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED = 'DB_QUERY_FAILED',
  API_RATE_LIMIT = 'API_RATE_LIMIT',
  API_REQUEST_FAILED = 'API_REQUEST_FAILED',
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
  INVALID_PARAMETERS = 'INVALID_PARAMETERS',
  WSS_CONNECTION_FAILED = 'WSS_CONNECTION_FAILED'
}

export class WalletSourceError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WalletSourceError';
  }
}
