// Sends a project's media bytes to Diffio's media host by following the `upload.requests` descriptors that
// `POST /v2/projects` (and `POST /v2/projects/{id}/upload`) return: `start` once, `part` once per part
// (numbered from 1, every part but the last exactly `part_size_bytes`), then `complete` listing every part.
// Parts go up to three at a time with up to four attempts each; a fatal failure sends `abort`.

import { DiffioUploadError } from "../errors";
import type { ProjectUpload, UploadRequest } from "../api/types";
import { fetchWithTimeout } from "./transport";
import { sleep } from "./retry";

/** Bytes to upload: a size and a reader for [start, end). */
export interface UploadSource {
  sizeBytes: number;
  read(start: number, end: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export interface EdgeUploadPartPlan {
  partNumber: number;
  startByte: number;
  endByte: number;
}

export interface EdgeUploadPartReceipt {
  partNumber: number;
  etag: string;
}

/** The media host's answer to `complete`. */
export interface EdgeUploadCompletion {
  sizeBytes: number;
  etag: string;
}

export interface EdgeUploadOptions {
  upload: ProjectUpload;
  source: UploadSource;
  fetch: typeof fetch;
  /** Parts in flight at once (default 3). */
  partConcurrency?: number;
  /** Attempts per request, first included (default 4). */
  maxAttempts?: number;
  /** Seconds before one media host request gives up (default 300; a 32 MiB part needs about 1 Mbit/s). */
  timeout?: number;
  signal?: AbortSignal;
  /** Called after each part lands. */
  onProgress?: (progress: { bytes_sent: number; bytes_total: number; parts_done: number; parts_total: number }) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_PART_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_SECONDS = 300;
const PER_PART_PLACEHOLDERS = ["part_number", "etag", "part_length"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
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

/** Backoff before attempt `attempt` (2 = first retry): 1 s, 2 s, 4 s, capped at 8 s. */
export function resolveEdgeUploadRetryDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 2));
}

type Vars = Record<string, string | number>;

/** Replaces `{name}` placeholders in a string; a string that is only one placeholder keeps the value's type. */
export function fillTemplateString(template: string, vars: Vars): string | number {
  const whole = /^\{(\w+)\}$/.exec(template);
  if (whole && whole[1] in vars) return vars[whole[1]];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

const mentionsPerPartPlaceholder = (value: unknown): boolean => {
  const text = JSON.stringify(value) ?? "";
  return PER_PART_PLACEHOLDERS.some((name) => text.includes(`{${name}}`));
};

/**
 * Fills a descriptor body template. An array whose items name per-part placeholders (`{part_number}`,
 * `{etag}`) is expanded once per part, so `"parts": [{"partNumber": "{part_number}", "etag": "{etag}"}]`
 * becomes the full sorted part list with numeric part numbers.
 */
export function fillTemplate(template: unknown, vars: Vars, parts: EdgeUploadPartReceipt[] = []): unknown {
  if (typeof template === "string") return fillTemplateString(template, vars);
  if (Array.isArray(template)) {
    if (template.length > 0 && template.every(mentionsPerPartPlaceholder)) {
      return parts.flatMap((part) =>
        template.map((item) => fillTemplate(item, { ...vars, part_number: part.partNumber, etag: part.etag }, parts))
      );
    }
    return template.map((item) => fillTemplate(item, vars, parts));
  }
  if (isRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillTemplate(value, vars, parts)]));
  }
  return template;
}

/** The standard descriptors, for an `upload` object without `requests` (older answers). */
export function defaultUploadRequests(upload: Pick<ProjectUpload, "edge_base_url" | "upload_token">): ProjectUpload["requests"] {
  const edge = `${upload.edge_base_url.replace(/\/+$/, "")}/v1/uploads`;
  const auth = { Authorization: `Bearer ${upload.upload_token}` };
  const json = { ...auth, "Content-Type": "application/json" };
  return {
    start: { method: "POST", url: `${edge}/start`, headers: auth, body: null, returns: ["uploadId"], description: "" },
    part: {
      method: "PUT",
      url: `${edge}/parts/{part_number}?uploadId={upload_id}`,
      headers: { ...auth, "Content-Length": "{part_length}" },
      body: null,
      returns: ["partNumber", "etag"],
      description: ""
    },
    complete: {
      method: "POST",
      url: `${edge}/complete`,
      headers: json,
      body: { uploadId: "{upload_id}", parts: [{ partNumber: "{part_number}", etag: "{etag}" }] },
      returns: ["sizeBytes", "etag"],
      description: ""
    },
    abort: { method: "POST", url: `${edge}/abort`, headers: json, body: { uploadId: "{upload_id}" }, returns: [], description: "" }
  };
}

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Turns a non-2xx media host answer (`{"error": {"code", "message"}}`) into a typed upload error. */
export function classifyEdgeUploadResponse(status: number, bodyText: string): DiffioUploadError {
  const body = parseJson(bodyText);
  const error = isRecord(body.error) ? body.error : {};
  const message = typeof error.message === "string" && error.message
    ? error.message
    : `The media host refused the upload with HTTP ${status}`;
  const code = typeof error.code === "string" && error.code
    ? error.code
    : status === 413 ? "payload_too_large" : status === 401 || status === 403 ? "invalid_token" : "upload_failed";
  const retryable = status === 408 || status === 429 || status >= 500;
  return new DiffioUploadError({ code, message, status, retryable, body: Object.keys(body).length ? body : bodyText });
}

function toUploadError(error: unknown, signal?: AbortSignal): DiffioUploadError {
  if (error instanceof DiffioUploadError) return error;
  const name = isRecord(error) || error instanceof Error ? (error as { name?: unknown }).name : undefined;
  if (signal?.aborted || name === "AbortError") {
    return new DiffioUploadError({ code: "canceled", message: "The upload was canceled." });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DiffioUploadError({ code: "network", message: message || "Network error during upload", retryable: true });
}

/** Uploads the bytes through the descriptors and returns the media host's completion receipt. */
export async function uploadToMediaHost(options: EdgeUploadOptions): Promise<EdgeUploadCompletion> {
  const { upload, source, signal } = options;
  const wait = options.sleep ?? ((ms: number) => sleep(ms, signal));
  const concurrency = Math.max(1, options.partConcurrency ?? DEFAULT_PART_CONCURRENCY);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = (options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const requests = upload.requests?.start && upload.requests?.part && upload.requests?.complete
    ? upload.requests
    : defaultUploadRequests(upload);
  if (upload.max_bytes && source.sizeBytes > upload.max_bytes) {
    throw new DiffioUploadError({
      code: "too_large",
      message: `This file is ${source.sizeBytes} bytes; the upload limit is ${upload.max_bytes} bytes.`
    });
  }

  const send = async (
    descriptor: UploadRequest,
    vars: Vars,
    body: Uint8Array | undefined,
    parts?: EdgeUploadPartReceipt[]
  ): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
      // fetch sets Content-Length from the body; browsers refuse to let scripts set it.
      if (name.toLowerCase() === "content-length") continue;
      headers[name] = String(fillTemplateString(String(value), vars));
    }
    let requestBody: BodyInit | undefined;
    if (body) requestBody = body as unknown as BodyInit;
    else if (descriptor.body != null) requestBody = JSON.stringify(fillTemplate(descriptor.body, vars, parts));
    let response: Response;
    try {
      response = await fetchWithTimeout(
        options.fetch,
        String(fillTemplateString(descriptor.url, vars)),
        { method: descriptor.method, headers, body: requestBody },
        timeoutMs,
        signal
      );
    } catch (error) {
      throw toUploadError(error, signal);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw classifyEdgeUploadResponse(response.status, text);
    return parseJson(text);
  };

  let fatalError: DiffioUploadError | null = null;
  const withRetries = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const uploadError = toUploadError(error, signal);
        if (fatalError || !uploadError.retryable || attempt >= maxAttempts) throw fatalError ?? uploadError;
        await wait(resolveEdgeUploadRetryDelayMs(attempt + 1));
      }
    }
  };

  // Every step is safe to repeat: a repeated start opens a fresh multipart upload, parts overwrite, and the
  // media host answers a repeated complete from the stored object.
  const started = await withRetries(async () => {
    const body = await send(requests.start, {}, undefined);
    if (typeof body.uploadId !== "string" || !body.uploadId) {
      throw new DiffioUploadError({ code: "invalid_response", message: "The media host did not return an uploadId." });
    }
    return body;
  });
  const uploadId = started.uploadId as string;
  const partSize = typeof started.partSizeBytes === "number" && Number.isSafeInteger(started.partSizeBytes) &&
    started.partSizeBytes > 0
    ? started.partSizeBytes
    : upload.part_size_bytes;

  const plan = planEdgeUploadParts(source.sizeBytes, partSize);
  const pending = [...plan];
  const receipts: EdgeUploadPartReceipt[] = [];
  let bytesSent = 0;

  const uploadPart = async (part: EdgeUploadPartPlan): Promise<void> => {
    let bytes: Uint8Array | null = null;
    const etag = await withRetries(async () => {
      if (fatalError) throw fatalError;
      bytes = bytes ?? await source.read(part.startByte, part.endByte);
      const vars = { part_number: part.partNumber, upload_id: uploadId, part_length: bytes.byteLength };
      const body = await send(requests.part, vars, bytes);
      if (typeof body.etag !== "string" || !body.etag) {
        throw new DiffioUploadError({ code: "invalid_response", message: `Part ${part.partNumber} returned no etag.` });
      }
      return body.etag;
    });
    receipts.push({ partNumber: part.partNumber, etag });
    bytesSent += part.endByte - part.startByte;
    options.onProgress?.({
      bytes_sent: bytesSent,
      bytes_total: source.sizeBytes,
      parts_done: receipts.length,
      parts_total: plan.length
    });
  };

  const lane = async (): Promise<void> => {
    while (pending.length > 0 && !fatalError) {
      const part = pending.shift();
      if (!part) return;
      try {
        await uploadPart(part);
      } catch (error) {
        fatalError = fatalError ?? toUploadError(error, signal);
        throw fatalError;
      }
    }
  };

  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, plan.length) }, lane));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    const uploadError = fatalError ?? toUploadError(failed.reason, signal);
    if (requests.abort) {
      // Release the stored parts; a failure here never hides the transfer error.
      await send(requests.abort, { upload_id: uploadId }, undefined).catch(() => undefined);
    }
    throw uploadError;
  }

  receipts.sort((left, right) => left.partNumber - right.partNumber);
  const completion = await withRetries(() => send(requests.complete, { upload_id: uploadId }, undefined, receipts));
  const sizeBytes = typeof completion.sizeBytes === "number" ? completion.sizeBytes : source.sizeBytes;
  if (sizeBytes !== source.sizeBytes) {
    throw new DiffioUploadError({
      code: "invalid_response",
      message: `The media host stored ${sizeBytes} bytes but the file has ${source.sizeBytes} bytes.`
    });
  }
  return { sizeBytes, etag: typeof completion.etag === "string" ? completion.etag : "" };
}
