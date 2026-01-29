export class DiffioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffioError";
  }
}

export class DiffioApiError extends DiffioError {
  statusCode?: number;
  responseBody?: unknown;

  constructor(message: string, options?: { statusCode?: number; responseBody?: unknown }) {
    super(message);
    this.name = "DiffioApiError";
    this.statusCode = options?.statusCode;
    this.responseBody = options?.responseBody;
  }
}

export class DiffioTimeoutError extends DiffioError {
  constructor(message: string) {
    super(message);
    this.name = "DiffioTimeoutError";
  }
}
