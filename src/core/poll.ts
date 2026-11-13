import { DiffioResourceFailedError, DiffioTimeoutError } from "../errors";
import { sleep } from "./retry";

/** Options of the `wait` helpers. */
export interface WaitOptions<T> {
  /** Seconds to keep polling before throwing DiffioTimeoutError. */
  timeout?: number;
  /** Seconds between polls (default 2). */
  pollInterval?: number;
  /** Called with every state read, the last one included. */
  onProgress?: (resource: T) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Polls `read` until `isDone` says it finished. A resource whose `status` is `failed` throws
 * DiffioResourceFailedError with its `error.code` and `error.message`.
 */
export async function pollUntil<T extends { status: string; error?: { code?: string; message?: string } | null }>(
  read: () => Promise<T>,
  isDone: (resource: T) => boolean,
  what: string,
  options: WaitOptions<T> & { defaultTimeout: number }
): Promise<T> {
  const timeoutSeconds = options.timeout ?? options.defaultTimeout;
  const intervalMs = Math.max(0, (options.pollInterval ?? 2) * 1000);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const resource = await read();
    if (options.onProgress) await options.onProgress(resource);
    if (resource.status === "failed") {
      const code = resource.error?.code ?? "failed";
      const message = resource.error?.message ?? `The ${what} failed.`;
      throw new DiffioResourceFailedError(code, message, resource);
    }
    if (isDone(resource)) return resource;
    if (Date.now() + intervalMs > deadline) {
      throw new DiffioTimeoutError(
        `Timed out after ${timeoutSeconds} s waiting for the ${what} (last status ${resource.status}).`,
        resource
      );
    }
    await sleep(intervalMs, options.signal);
  }
}
