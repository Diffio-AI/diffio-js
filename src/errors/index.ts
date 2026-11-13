/** Base class of every error the SDK throws. */
export class DiffioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffioError";
  }
}

/**
 * A refusal from the Diffio API: the v2 error body `{"error": {"code", "message", "request_id", "details"}}`
 * with the HTTP status. `request_id` matches the response's `X-Request-Id`; quote it when you contact support.
 */
export class DiffioApiError extends DiffioError {
  /** HTTP status, such as 400, 404 or 409. */
  readonly status: number;
  /** Stable snake_case error code, such as `unknown_model` or `project_not_found`. */
  readonly code: string;
  readonly request_id: string | null;
  /** Extra fields for this code, such as `{"field": "model"}`; `{}` when the API sent none. */
  readonly details: Record<string, unknown>;
  /** Response headers, when there was a response. */
  readonly headers: Headers | null;
  /** The parsed response body (or its text when it was not JSON). */
  readonly body: unknown;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    request_id?: string | null;
    details?: Record<string, unknown> | null;
    headers?: Headers | null;
    body?: unknown;
  }) {
    super(options.message);
    this.name = "DiffioApiError";
    this.status = options.status;
    this.code = options.code;
    this.request_id = options.request_id ?? null;
    this.details = options.details ?? {};
    this.headers = options.headers ?? null;
    this.body = options.body;
  }
}

/**
 * A failed transfer of media bytes to Diffio's media host (the `upload.requests` steps).
 * `code` is the media host's error code (such as `invalid_token` or `payload_too_large`), or one of the
 * SDK's own codes: `network`, `invalid_response`, `too_large`, `canceled`.
 */
export class DiffioUploadError extends DiffioApiError {
  /** True when sending the same upload again may succeed (network trouble, 5xx, 429). */
  readonly retryable: boolean;
  /** The project whose upload did not finish, when known. */
  project_id: string | null;

  constructor(options: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
    project_id?: string | null;
    body?: unknown;
  }) {
    super({
      status: options.status ?? 0,
      code: options.code,
      message: options.message,
      body: options.body
    });
    this.name = "DiffioUploadError";
    this.retryable = options.retryable ?? false;
    this.project_id = options.project_id ?? null;
  }
}

/** The request never got an HTTP answer (DNS, TLS, reset connection) after every retry. */
export class DiffioConnectionError extends DiffioError {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DiffioConnectionError";
    this.cause = cause;
  }
}

/** A request took longer than its timeout, or a `wait` helper ran out of time. */
export class DiffioTimeoutError extends DiffioError {
  /** For `wait` helpers: the last state read before giving up. */
  readonly resource: unknown;

  constructor(message: string, resource?: unknown) {
    super(message);
    this.name = "DiffioTimeoutError";
    this.resource = resource ?? null;
  }
}

/**
 * Thrown by `wait` helpers when a generation, export or assistant turn ends `failed`.
 * `code` and `message` are the resource's `error`; `resource` is the failed object itself.
 */
export class DiffioResourceFailedError extends DiffioError {
  readonly code: string;
  readonly resource: unknown;

  constructor(code: string, message: string, resource: unknown) {
    super(message);
    this.name = "DiffioResourceFailedError";
    this.code = code;
    this.resource = resource;
  }
}

/** A webhook delivery whose signature, timestamp or headers do not check out. */
export class DiffioWebhookVerificationError extends DiffioError {
  constructor(message: string) {
    super(message);
    this.name = "DiffioWebhookVerificationError";
  }
}
