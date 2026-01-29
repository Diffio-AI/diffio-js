export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries: number;
  retryBackoff: number;
  retryStatusCodes: number[];
}

export async function requestWithRetries(
  requestFn: () => Promise<Response>,
  { maxRetries, retryBackoff, retryStatusCodes }: RetryOptions
): Promise<Response> {
  let attempt = 0;

  while (true) {
    try {
      const response = await requestFn();
      if (
        retryStatusCodes.length > 0 &&
        retryStatusCodes.includes(response.status) &&
        attempt < maxRetries
      ) {
        response.body?.cancel?.();
        await sleep(retryBackoff * 1000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await sleep(retryBackoff * 1000 * 2 ** attempt);
      attempt += 1;
    }
  }
}
