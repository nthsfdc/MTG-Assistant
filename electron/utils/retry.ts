const MAX_ATTEMPTS = 3;
const DELAYS       = [2000, 4000, 8000]; // delays between attempt 1→2, 2→3

/** Status codes that are never worth retrying (client fault). */
const NON_RETRYABLE = new Set([400, 401, 403, 404, 413, 422]);

/** Status codes that are transient and safe to retry. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Node.js network error codes that are safe to retry. */
const RETRYABLE_CODE = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'ECONNREFUSED']);

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== undefined) {
    if (NON_RETRYABLE.has(status)) return false;
    if (RETRYABLE_STATUS.has(status)) return true;
    // Any other explicit HTTP status → not retryable
    return false;
  }
  const code = (err as { code?: string })?.code;
  if (code && RETRYABLE_CODE.has(code)) return true;

  // Timeout / network error messages
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnreset')) return true;

  // No status code at all → likely a network/transport error → retryable
  return true;
}

/**
 * Retry an async function up to MAX_ATTEMPTS times with exponential backoff.
 * Non-retryable errors (4xx client errors) are thrown immediately.
 */
export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, DELAYS[i]));
      }
    }
  }
  throw lastErr;
}
