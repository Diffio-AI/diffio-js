export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (reason) return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Statuses worth sending again: timeouts, rate limits and server-side failures. */
export const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Delay before retry number `attempt` (1 = first retry): `backoff * 2^(attempt-1)` seconds with up to 25 %
 * jitter, capped at 8 s, or the server's `Retry-After` (seconds, capped at 60 s) when it sent one.
 */
export function retryDelayMs(attempt: number, backoffSeconds: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60, seconds) * 1000;
  }
  const base = Math.min(8, backoffSeconds * 2 ** Math.max(0, attempt - 1)) * 1000;
  return Math.round(base * (1 + Math.random() * 0.25));
}
