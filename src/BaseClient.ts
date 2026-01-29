import { DIFFIO_SDK_VERSION } from "./version";
import { mergeHeaders } from "./core/headers";
import type { Supplier } from "./core/supplier";

export interface BaseClientOptions {
  baseUrl?: Supplier<string>;
  apiKey?: Supplier<string | undefined>;
  headers?: Record<string, string | Supplier<string | null | undefined> | null | undefined>;
  timeoutInSeconds?: number;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  retryStatusCodes?: number[];
  fetch?: typeof fetch;
}

export interface BaseRequestOptions {
  timeoutInSeconds?: number;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  retryStatusCodes?: number[];
  abortSignal?: AbortSignal;
  apiKey?: string | undefined;
  headers?: Record<string, string | Supplier<string | null | undefined> | null | undefined>;
}

export type NormalizedClientOptions<T extends BaseClientOptions> = T & {
  headers: Record<string, string | Supplier<string | null | undefined> | null | undefined>;
};

export function normalizeClientOptions<T extends BaseClientOptions>(options: T): NormalizedClientOptions<T> {
  const headers = mergeHeaders(
    {
      "X-Diffio-SDK-Language": "JavaScript",
      "X-Diffio-SDK-Name": "diffio",
      "X-Diffio-SDK-Version": DIFFIO_SDK_VERSION,
      "User-Agent": `diffio/${DIFFIO_SDK_VERSION}`
    },
    options?.headers
  );

  return {
    ...options,
    headers
  } as NormalizedClientOptions<T>;
}
