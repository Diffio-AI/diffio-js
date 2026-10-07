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

/** Stable failure codes for uploads through the edge Worker, modeled on the Diffio web uploader's codes. */
export type EdgeUploadErrorCode =
  | "upload/too-large"
  | "upload/unauthorized"
  | "upload/rejected"
  | "upload/network"
  | "upload/server"
  | "upload/invalid-response"
  | "upload/canceled";

/** A failed project media upload; `apiProjectId` names the project whose upload did not finish. */
export class DiffioUploadError extends DiffioApiError {
  uploadErrorCode: EdgeUploadErrorCode;
  /** The edge's machine-readable `error.code`, such as `token_expired`, when it sent one. */
  edgeErrorCode?: string;
  retryable: boolean;
  apiProjectId?: string;

  constructor(
    uploadErrorCode: EdgeUploadErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: unknown;
      edgeErrorCode?: string;
      retryable?: boolean;
      apiProjectId?: string;
    }
  ) {
    super(message, { statusCode: options?.statusCode, responseBody: options?.responseBody });
    this.name = "DiffioUploadError";
    this.uploadErrorCode = uploadErrorCode;
    this.edgeErrorCode = options?.edgeErrorCode;
    this.retryable = options?.retryable ?? false;
    this.apiProjectId = options?.apiProjectId;
  }
}

export class DiffioTimeoutError extends DiffioError {
  constructor(message: string) {
    super(message);
    this.name = "DiffioTimeoutError";
  }
}
