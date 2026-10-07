// Client for the edge Worker upload API ("Uploads" in diffio-ui specs/MacFleetArchitecture.md).
// create_project opens the session and owns every auth decision; the edge only checks the
// session's upload token and streams fixed-size parts into R2. The flow mirrors the web app's
// uploader (diffio-ui app/services/edgeUploads.ts): start, PUT parts numbered from 1 with up to
// four attempts each, complete with the sorted receipts, and abort on a fatal failure.

import { DiffioUploadError, type EdgeUploadErrorCode } from "../errors";

/** The upload session create_project returns; `uploadToken` authorizes edge calls for this one object. */
export interface EdgeUploadSession {
  uploadSessionId: string;
  edgeBaseUrl: string;
  uploadToken: string;
  objectKey: string;
  partSizeBytes: number;
  maxBytes: number;
  expiresAt: string;
}

/** One planned multipart part: bytes [startByte, endByte) of the file. */
export interface EdgeUploadPartPlan {
  partNumber: number;
  startByte: number;
  endByte: number;
}

/** A finished part as the edge acknowledges it, replayed on completion. */
export interface EdgeUploadPartReceipt {
  partNumber: number;
  etag: string;
}

/** The edge's answer to `POST /v1/uploads/complete`. */
export interface EdgeUploadCompletion {
  objectKey: string;
  sizeBytes: number;
  etag: string;
}

/** One HTTP request to the edge; the body is a fixed-length buffer because parts need a Content-Length. */
export interface EdgeUploadHttpRequest {
  method: "POST" | "PUT";
  url: string;
  bearerToken: string;
  body: Uint8Array | string;
  contentType: string;
}

/** The edge's answer to one request. Transport failures are thrown instead. */
export interface EdgeUploadHttpResponse {
  status: number;
  bodyText: string;
}

/** Inputs for one upload of a project's original media through the edge. */
export interface EdgeUploadOptions {
  session: EdgeUploadSession;
  sizeBytes: number;
  /** Reads bytes [startByte, endByte) of the media; called once per part. */
  readPartBytes: (startByte: number, endByte: number) => Promise<Uint8Array>;
  sendEdgeRequest: (request: EdgeUploadHttpRequest) => Promise<EdgeUploadHttpResponse>;
  partConcurrency?: number;
  maxAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_EDGE_UPLOAD_PART_CONCURRENCY = 3;
const DEFAULT_EDGE_UPLOAD_MAX_ATTEMPTS = 4;

const defaultSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Splits a file into fixed-size parts numbered from 1; an empty file is one empty part. */
export function planEdgeUploadParts(sizeBytes: number, partSizeBytes: number): EdgeUploadPartPlan[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("sizeBytes must be a non-negative integer");
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) {
    throw new Error("partSizeBytes must be a positive integer");
  }
  if (sizeBytes === 0) return [{ partNumber: 1, startByte: 0, endByte: 0 }];
  const parts: EdgeUploadPartPlan[] = [];
  for (let startByte = 0, partNumber = 1; startByte < sizeBytes; startByte += partSizeBytes, partNumber += 1) {
    parts.push({ partNumber, startByte, endByte: Math.min(sizeBytes, startByte + partSizeBytes) });
  }
  return parts;
}

/** Backoff before retry `attempt` (2 = first retry): 1 s, 2 s, 4 s, capped at 8 s. */
export function resolveEdgeUploadRetryDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 2));
}

/** Validates the `upload` object of a create_project response; null when it is missing or incomplete. */
export function parseEdgeUploadSession(value: unknown): EdgeUploadSession | null {
  if (!isUnknownRecord(value)) return null;
  const { uploadSessionId, uploadToken, edgeBaseUrl, objectKey, partSizeBytes, maxBytes, expiresAt } = value;
  if (
    typeof uploadSessionId !== "string" || !uploadSessionId ||
    typeof uploadToken !== "string" || !uploadToken ||
    typeof edgeBaseUrl !== "string" || !/^https?:\/\//i.test(edgeBaseUrl) ||
    typeof objectKey !== "string" || !objectKey ||
    typeof partSizeBytes !== "number" || !Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0 ||
    typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
  ) {
    return null;
  }
  return {
    uploadSessionId,
    uploadToken,
    edgeBaseUrl: edgeBaseUrl.replace(/\/+$/, ""),
    objectKey,
    partSizeBytes,
    maxBytes,
    expiresAt: typeof expiresAt === "string" ? expiresAt : ""
  };
}

const parseJsonBody = (bodyText: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return isUnknownRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Classifies a non-2xx edge response (`{"error": {"code", "message"}}`) as a typed upload error. */
export function classifyEdgeUploadResponse(response: EdgeUploadHttpResponse): DiffioUploadError {
  const body = parseJsonBody(response.bodyText);
  const error = isUnknownRecord(body.error) ? body.error : {};
  const message = typeof error.message === "string" && error.message
    ? error.message
    : `Upload failed with HTTP ${response.status}`;
  const edgeErrorCode = typeof error.code === "string" ? error.code : undefined;
  const responseBody: unknown = Object.keys(body).length > 0 ? body : response.bodyText || null;
  const base = { statusCode: response.status, responseBody, edgeErrorCode };
  let code: EdgeUploadErrorCode = "upload/rejected";
  let retryable = false;
  if (response.status === 413) code = "upload/too-large";
  else if (response.status === 401 || response.status === 403) code = "upload/unauthorized";
  else if (response.status === 408 || response.status === 429 || response.status >= 500) {
    code = "upload/server";
    retryable = true;
  }
  return new DiffioUploadError(code, message, { ...base, retryable });
}

const isAbortError = (error: unknown): boolean =>
  isUnknownRecord(error) && (error as { name?: unknown }).name === "AbortError";

/** Turns a thrown transport failure into an upload error; caller aborts are final, other failures retryable. */
function toEdgeUploadError(error: unknown): DiffioUploadError {
  if (error instanceof DiffioUploadError) return error;
  if (isAbortError(error) || (error instanceof Error && error.name === "AbortError")) {
    return new DiffioUploadError("upload/canceled", "Upload was canceled.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DiffioUploadError("upload/network", message || "Network error during upload", { retryable: true });
}

/** Uploads media through the edge in parts and completes the multipart object; the caller then confirms it. */
export async function uploadProjectMediaToEdge(options: EdgeUploadOptions): Promise<EdgeUploadCompletion> {
  const { session, sizeBytes, readPartBytes, sendEdgeRequest } = options;
  const sleep = options.sleep ?? defaultSleep;
  const concurrency = Math.max(1, options.partConcurrency ?? DEFAULT_EDGE_UPLOAD_PART_CONCURRENCY);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_EDGE_UPLOAD_MAX_ATTEMPTS);
  if (sizeBytes > session.maxBytes) {
    throw new DiffioUploadError(
      "upload/too-large",
      `This file is ${sizeBytes} bytes; the upload limit is ${session.maxBytes} bytes.`
    );
  }

  const sendOnce = async (request: Omit<EdgeUploadHttpRequest, "bearerToken">): Promise<Record<string, unknown>> => {
    let response: EdgeUploadHttpResponse;
    try {
      response = await sendEdgeRequest({ ...request, bearerToken: session.uploadToken });
    } catch (error) {
      throw toEdgeUploadError(error);
    }
    if (response.status < 200 || response.status >= 300) throw classifyEdgeUploadResponse(response);
    return parseJsonBody(response.bodyText);
  };

  // Set by the first part that fails for good; the other lanes then stop instead of retrying.
  let fatalError: DiffioUploadError | null = null;

  // Start, parts, and complete are all safe to repeat: a repeated start only opens a fresh
  // multipart upload, and the edge answers a repeated complete from the stored object.
  const sendWithRetries = async <T>(
    describe: () => Omit<EdgeUploadHttpRequest, "bearerToken"> | Promise<Omit<EdgeUploadHttpRequest, "bearerToken">>,
    readResult: (body: Record<string, unknown>) => T
  ): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return readResult(await sendOnce(await describe()));
      } catch (error) {
        const uploadError = toEdgeUploadError(error);
        if (fatalError || !uploadError.retryable || attempt >= maxAttempts) throw fatalError ?? uploadError;
        await sleep(resolveEdgeUploadRetryDelayMs(attempt + 1));
      }
    }
  };

  const jsonRequest = (path: string, body: unknown): Omit<EdgeUploadHttpRequest, "bearerToken"> => ({
    method: "POST",
    url: `${session.edgeBaseUrl}${path}`,
    body: JSON.stringify(body),
    contentType: "application/json"
  });

  const started = await sendWithRetries(() => jsonRequest("/v1/uploads/start", {}), (body) => {
    if (typeof body.uploadId !== "string" || !body.uploadId) {
      throw new DiffioUploadError("upload/invalid-response", "The edge did not return an uploadId.");
    }
    const partSizeBytes = typeof body.partSizeBytes === "number" && Number.isSafeInteger(body.partSizeBytes) &&
      body.partSizeBytes > 0
      ? body.partSizeBytes
      : session.partSizeBytes;
    return { uploadId: body.uploadId, partSizeBytes };
  });
  const { uploadId } = started;

  const parts = planEdgeUploadParts(sizeBytes, started.partSizeBytes);
  const pending = [...parts];
  const receipts: EdgeUploadPartReceipt[] = [];

  const uploadPart = async (part: EdgeUploadPartPlan): Promise<void> => {
    let bytes: Uint8Array | null = null;
    const receipt = await sendWithRetries(async () => {
      if (fatalError) throw fatalError;
      bytes = bytes ?? await readPartBytes(part.startByte, part.endByte);
      return {
        method: "PUT",
        url: `${session.edgeBaseUrl}/v1/uploads/parts/${part.partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
        body: bytes,
        contentType: "application/octet-stream"
      };
    }, (body) => {
      if (typeof body.etag !== "string" || !body.etag) {
        throw new DiffioUploadError("upload/invalid-response", `Part ${part.partNumber} returned no etag.`);
      }
      return { partNumber: part.partNumber, etag: body.etag };
    });
    receipts.push(receipt);
  };

  const runLane = async (): Promise<void> => {
    while (pending.length > 0 && !fatalError) {
      const part = pending.shift();
      if (!part) return;
      try {
        await uploadPart(part);
      } catch (error) {
        fatalError = fatalError ?? toEdgeUploadError(error);
        throw fatalError;
      }
    }
  };

  const lanes = Array.from({ length: Math.min(concurrency, parts.length) }, () => runLane());
  const laneResults = await Promise.allSettled(lanes);
  const failedLane = laneResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failedLane) {
    const uploadError = fatalError ?? toEdgeUploadError(failedLane.reason);
    // Release the partial upload; a failure here never masks the transfer error.
    await sendOnce(jsonRequest("/v1/uploads/abort", { uploadId })).catch(() => undefined);
    throw uploadError;
  }

  receipts.sort((left, right) => left.partNumber - right.partNumber);
  const completion = await sendWithRetries(() => jsonRequest("/v1/uploads/complete", { uploadId, parts: receipts }), (body) => ({
    objectKey: typeof body.objectKey === "string" && body.objectKey ? body.objectKey : session.objectKey,
    sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : sizeBytes,
    etag: typeof body.etag === "string" ? body.etag : ""
  }));
  if (completion.sizeBytes !== sizeBytes) {
    throw new DiffioUploadError(
      "upload/invalid-response",
      `The edge stored ${completion.sizeBytes} bytes but the file has ${sizeBytes} bytes.`
    );
  }
  return completion;
}
