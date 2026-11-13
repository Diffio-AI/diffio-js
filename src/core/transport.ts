import { DIFFIO_SDK_VERSION } from "../version";
import { DiffioApiError, DiffioConnectionError, DiffioError, DiffioTimeoutError } from "../errors";
import { mergeHeaders, resolveHeaders, type HeaderRecord } from "./headers";
import { Supplier } from "./supplier";
import { DEFAULT_RETRY_STATUS_CODES, retryDelayMs, sleep } from "./retry";
import { DEFAULT_BASE_URL, resolveApiBaseUrl } from "./url";

/** Options every method accepts as its last argument. */
export interface RequestOptions {
  /** Sent as `Diffio-End-User`: act for one end user of your product. Overrides the client's `endUser`. */
  endUser?: string | null;
  /**
   * Sent as `Idempotency-Key` on the three calls that honour it (`projects.create`, `generations.create`,
   * `edits.create`). When left out the SDK makes one per call, so its own retries never create twice.
   */
  idempotencyKey?: string;
  /** Seconds before one HTTP attempt gives up. */
  timeout?: number;
  /** Retries after the first attempt (idempotent calls only). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Extra headers for this call. */
  headers?: Record<string, string | null | undefined>;
  /** Use another API key for this call. */
  apiKey?: string;
}

export interface TransportOptions {
  apiKey?: Supplier<string | undefined>;
  baseUrl?: Supplier<string | undefined>;
  endUser?: string | null;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  retryStatusCodes?: number[];
  headers?: HeaderRecord;
  fetch?: typeof fetch;
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Whether repeating the request is harmless; only these are retried. */
  idempotent: boolean;
  /** Send no API key (public routes such as `GET /models` and `GET /shares/{id}`). */
  noAuth?: boolean;
  /** Never send `Diffio-End-User` (account-level routes such as `POST /webhooks/portal` refuse it). */
  accountLevel?: boolean;
  /** This operation honours `Idempotency-Key`: send the caller's key, or make one. */
  acceptsIdempotencyKey?: boolean;
  /** Default timeout in seconds when neither the call nor the client sets one. */
  defaultTimeout?: number;
  options?: RequestOptions;
}

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BACKOFF_SECONDS = 0.5;

/** Status codes v2 answers without a code of its own, as the API maps them (api_v2_http.py). */
const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthenticated",
  402: "payment_required",
  403: "permission_denied",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  500: "internal_error",
  502: "internal_error",
  503: "unavailable",
  504: "unavailable"
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export { isNode } from "./node";
import { isNode } from "./node";

export const readEnv = (name: string): string | undefined => {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

/** A random v4 UUID from WebCrypto when present, else Math.random (only used for idempotency keys). */
export function randomId(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error as { name?: unknown }).name === "AbortError" ||
    (error instanceof Error && error.name === "AbortError");
}

/** Builds the typed error for a non-2xx answer from its body (v2 error shape) and headers. */
export function apiErrorFromResponse(status: number, body: unknown, headers: Headers | null): DiffioApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error && typeof error.code === "string" && error.code ? error.code : CODE_BY_STATUS[status] ??
    (status >= 500 ? "internal_error" : "invalid_request");
  const message = error && typeof error.message === "string" && error.message
    ? error.message
    : typeof body === "string" && body.trim() && body.length < 500
      ? body.trim()
      : `Request failed with HTTP ${status}`;
  const requestId = error && typeof error.request_id === "string"
    ? error.request_id
    : headers?.get("x-request-id") ?? null;
  const details = error && isRecord(error.details) ? error.details : {};
  return new DiffioApiError({ status, code, message, request_id: requestId, details, headers, body });
}

/** Runs `fetch` with a timeout and an optional caller signal; a timeout becomes DiffioTimeoutError. */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs != null && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new DiffioTimeoutError(`Request timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Sends v2 API requests: auth, SDK headers, end-user and idempotency headers, retries and typed errors. */
export class Transport {
  readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get fetchFn(): typeof fetch {
    const fetchFn = this.options.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchFn) throw new DiffioError("fetch is not available in this runtime; pass options.fetch");
    return fetchFn;
  }

  async baseUrl(): Promise<string> {
    const base = (await Supplier.get(this.options.baseUrl)) ?? readEnv("DIFFIO_API_BASE_URL") ?? DEFAULT_BASE_URL;
    return resolveApiBaseUrl(base);
  }

  retryPolicy(options?: RequestOptions): { maxRetries: number; backoff: number; statuses: number[] } {
    return {
      maxRetries: Math.max(0, options?.maxRetries ?? this.options.maxRetries ?? DEFAULT_MAX_RETRIES),
      backoff: this.options.retryBackoff ?? DEFAULT_RETRY_BACKOFF_SECONDS,
      statuses: this.options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES
    };
  }

  private async buildHeaders(request: ApiRequest): Promise<Record<string, string>> {
    const options = request.options;
    const sdkHeaders: HeaderRecord = {
      Accept: "application/json",
      "X-Diffio-SDK-Language": "JavaScript",
      "X-Diffio-SDK-Name": "diffio",
      "X-Diffio-SDK-Version": DIFFIO_SDK_VERSION
    };
    // Browsers would need User-Agent in the CORS allow list, so only Node sends it.
    if (isNode()) sdkHeaders["User-Agent"] = `diffio-js/${DIFFIO_SDK_VERSION}`;

    const extra: HeaderRecord = {};
    if (!request.noAuth) {
      const apiKey = options?.apiKey ?? (await Supplier.get(this.options.apiKey)) ?? readEnv("DIFFIO_API_KEY");
      if (!apiKey) {
        throw new DiffioError("No API key: pass apiKey to new DiffioClient(...) or set DIFFIO_API_KEY.");
      }
      extra.Authorization = `Bearer ${apiKey}`;
    }
    const endUser = options?.endUser !== undefined ? options.endUser : this.options.endUser;
    if (endUser && !request.noAuth && !request.accountLevel) extra["Diffio-End-User"] = endUser;
    if (request.body !== undefined) extra["Content-Type"] = "application/json";
    return resolveHeaders(mergeHeaders(sdkHeaders, this.options.headers, extra, options?.headers));
  }

  /** Sends one request and returns the parsed JSON body; throws DiffioApiError on a refusal. */
  async request<T>(request: ApiRequest): Promise<T> {
    const options = request.options;
    const url = `${await this.baseUrl()}${request.path}`;
    const headers = await this.buildHeaders(request);
    let idempotent = request.idempotent;
    if (request.acceptsIdempotencyKey) {
      headers["Idempotency-Key"] = options?.idempotencyKey ?? randomId();
      idempotent = true;
    }
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const timeoutSeconds = options?.timeout ?? this.options.timeout ?? request.defaultTimeout ?? DEFAULT_TIMEOUT_SECONDS;
    const { maxRetries, backoff, statuses } = this.retryPolicy(options);
    const fetchFn = this.fetchFn;

    for (let attempt = 0; ; attempt += 1) {
      const canRetry = idempotent && attempt < maxRetries;
      let response: Response;
      try {
        response = await fetchWithTimeout(
          fetchFn,
          url,
          { method: request.method, headers, body },
          timeoutSeconds * 1000,
          options?.signal
        );
      } catch (error) {
        if (options?.signal?.aborted || (isAbortError(error) && !(error instanceof DiffioTimeoutError))) throw error;
        if (canRetry) {
          await sleep(retryDelayMs(attempt + 1, backoff), options?.signal);
          continue;
        }
        if (error instanceof DiffioError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new DiffioConnectionError(`Could not reach the Diffio API: ${message}`, error);
      }

      if (response.ok) {
        const text = await response.text();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new DiffioApiError({
            status: response.status,
            code: "invalid_response",
            message: "The Diffio API answered with a body that is not JSON.",
            request_id: response.headers.get("x-request-id"),
            headers: response.headers,
            body: text
          });
        }
      }

      if (canRetry && statuses.includes(response.status)) {
        await response.arrayBuffer().catch(() => undefined);
        await sleep(retryDelayMs(attempt + 1, backoff, response.headers.get("retry-after")), options?.signal);
        continue;
      }
      const text = await response.text().catch(() => "");
      let parsed: unknown = text || null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      throw apiErrorFromResponse(response.status, parsed, response.headers);
    }
  }
}
