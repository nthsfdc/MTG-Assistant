const DELAYS = [0, 2000, 4000, 8000]; // 4 attempts: immediate, 2s, 4s, 8s
const NON_RETRYABLE = new Set([400, 401, 403, 413]);

export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < DELAYS.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, DELAYS[i]));
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (status !== undefined && NON_RETRYABLE.has(status)) throw err;
    }
  }
  throw lastErr;
}
