import type { BaseClientOptions, BaseRequestOptions, NormalizedClientOptions } from "./BaseClient";
import { normalizeClientOptions } from "./BaseClient";
import { mergeHeaders, mergeOnlyDefinedHeaders, resolveHeaders } from "./core/headers";
import { Supplier } from "./core/supplier";
import { join } from "./core/url";
import { requestWithRetries } from "./core/retry";
import { DiffioApiError, DiffioTimeoutError } from "./errors";
import {
  createAudioIsolationResult,
  parseCreateGenerationResponse,
  parseCreateProjectResponse,
  parseGenerationDownloadResponse,
  parseGenerationProgressResponse,
  parseListProjectGenerationsResponse,
  parseListProjectsResponse,
  parseWebhookTestEventResponse
} from "./api/serialization";
import type {
  AudioIsolationResult,
  CreateGenerationResponse,
  CreateProjectResponse,
  GenerationDownloadResponse,
  GenerationProgressResponse,
  ListProjectGenerationsResponse,
  ListProjectsResponse,
  RestoreMetadata,
  WebhookTestEventResponse
} from "./api/types";
import { AudioIsolationClient, GenerationsClient, ProjectsClient, WebhooksClient } from "./api/resources";
import { lookup as lookupMimeType } from "mime-types";

const DEFAULT_BASE_URL = "https://us-central1-diffioai.cloudfunctions.net";
const API_PREFIX = "v1";
const MODEL_ENDPOINTS: Record<string, string> = {
  "diffio-2": "diffio-2.0-generation",
  "diffio-2-flash": "diffio-2.0-flash-generation",
  "diffio-3": "diffio-3.0-generation"
};
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const DEFAULT_RETRY_BACKOFF = 0.5;
const DEFAULT_TIMEOUT_SECONDS = 60;
const WEBHOOK_EVENT_TYPES = [
  "generation.queued",
  "generation.processing",
  "generation.failed",
  "generation.completed"
];
const WEBHOOK_MODES = ["test", "live"];

export declare namespace DiffioClient {
  export type Options = BaseClientOptions;

  export interface RequestOptions extends BaseRequestOptions {}
}

export class DiffioClient {
  protected readonly _options: NormalizedClientOptions<DiffioClient.Options>;
  public readonly audioIsolation: AudioIsolationClient;
  public readonly generations: GenerationsClient;
  public readonly projects: ProjectsClient;
  public readonly webhooks: WebhooksClient;

  constructor(options: DiffioClient.Options = {}) {
    const envApiKey = typeof process !== "undefined" ? process.env.DIFFIO_API_KEY : undefined;
    const apiKey = options.apiKey ?? envApiKey;
    if (apiKey == null) {
      throw new DiffioApiError("apiKey is required");
    }

    this._options = normalizeClientOptions({ ...options, apiKey });
    this.audioIsolation = new AudioIsolationClient(this);
    this.generations = new GenerationsClient(this);
    this.projects = new ProjectsClient(this);
    this.webhooks = new WebhooksClient(this);
  }

  close(): void {
    return;
  }

  async createProject(options: {
    filePath: string;
    contentType?: string;
    contentLength?: number;
    params?: Record<string, unknown>;
    fileFormat?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<CreateProjectResponse> {
    const { filePath, contentType, contentLength, params, fileFormat, requestOptions } = options;
    if (!filePath) {
      throw new DiffioApiError("filePath is required");
    }

    const resolvedFileName = getBaseName(filePath);
    const resolvedContentType = contentType ?? guessContentType(filePath) ?? "application/octet-stream";
    let resolvedContentLength = contentLength;
    if (resolvedContentLength == null && filePath) {
      resolvedContentLength = getFileSize(filePath);
    }

    const payload: Record<string, unknown> = {
      fileName: resolvedFileName,
      contentType: resolvedContentType
    };
    if (resolvedContentLength != null) {
      payload.contentLength = Number(resolvedContentLength);
    }
    if (params) {
      payload.params = params;
    }
    if (fileFormat != null) {
      payload.fileFormat = fileFormat;
    }

    const response = await this._requestJson("POST", "create_project", payload, requestOptions);
    const project = parseCreateProjectResponse(response);
    await this._uploadFile({
      uploadUrl: project.uploadUrl,
      uploadMethod: project.uploadMethod,
      filePath,
      contentType: resolvedContentType,
      requestOptions
    });
    return project;
  }

  private async _uploadFile(options: {
    uploadUrl: string;
    uploadMethod?: string;
    filePath?: string;
    data?: unknown;
    contentType?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<void> {
    const { uploadUrl, uploadMethod, filePath, data, contentType, requestOptions } = options;
    if ((filePath == null) === (data == null)) {
      throw new DiffioApiError("Provide filePath or data");
    }

    let resolvedContentType = contentType;
    if (!resolvedContentType && filePath) {
      const guessed = lookupMimeType(filePath);
      resolvedContentType = typeof guessed === "string" ? guessed : undefined;
    }
    if (!resolvedContentType) {
      resolvedContentType = "application/octet-stream";
    }

    const method = (uploadMethod || "PUT").toUpperCase();
    const extraHeaders: Record<string, string> = {
      "Content-Type": resolvedContentType
    };
    if (isStorageEmulatorUrl(uploadUrl)) {
      extraHeaders.Authorization = "Bearer owner";
    }

    const body = filePath ? await createFileReadStream(filePath) : data;
    await this._requestBinary(method, uploadUrl, body, requestOptions, extraHeaders, true);
  }

  async createGeneration(options: {
    apiProjectId: string;
    model?: string;
    sampling?: Record<string, unknown>;
    params?: Record<string, unknown>;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<CreateGenerationResponse> {
    const { apiProjectId, model = "diffio-2", sampling, params, requestOptions } = options;
    const endpoint = MODEL_ENDPOINTS[model];
    if (!endpoint) {
      throw new DiffioApiError(`Unsupported model: ${model}`);
    }

    const payload: Record<string, unknown> = { apiProjectId };
    if (sampling != null) {
      payload.sampling = sampling;
    }
    if (params) {
      payload.params = params;
    }

    const response = await this._requestJson("POST", endpoint, payload, requestOptions);
    return parseCreateGenerationResponse(response);
  }

  async listProjects(options: { requestOptions?: DiffioClient.RequestOptions } = {}): Promise<ListProjectsResponse> {
    const response = await this._requestJson("POST", "list_projects", {}, options.requestOptions);
    return parseListProjectsResponse(response);
  }

  async listProjectGenerations(options: {
    apiProjectId: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<ListProjectGenerationsResponse> {
    const { apiProjectId, requestOptions } = options;
    if (!apiProjectId) {
      throw new DiffioApiError("apiProjectId is required");
    }
    const response = await this._requestJson(
      "POST",
      "list_project_generations",
      { apiProjectId },
      requestOptions
    );
    return parseListProjectGenerationsResponse(response);
  }

  async getGenerationProgress(options: {
    generationId: string;
    apiProjectId?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<GenerationProgressResponse> {
    const { generationId, apiProjectId, requestOptions } = options;
    const payload: Record<string, unknown> = { generationId };
    if (apiProjectId != null) {
      payload.apiProjectId = apiProjectId;
    }
    const response = await this._requestJson("POST", "get_generation_progress", payload, requestOptions);
    return parseGenerationProgressResponse(response);
  }

  async waitForGeneration(options: {
    generationId: string;
    apiProjectId?: string;
    pollInterval?: number;
    timeout?: number;
    timeoutInSeconds?: number;
    onProgress?: (progress: GenerationProgressResponse) => void | Promise<void>;
    showProgress?: boolean;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<GenerationProgressResponse> {
    const {
      generationId,
      apiProjectId,
      pollInterval = 2,
      timeout,
      timeoutInSeconds,
      onProgress,
      showProgress,
      requestOptions
    } = options;
    const timeoutSeconds = timeoutInSeconds ?? timeout ?? DEFAULT_TIMEOUT_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastProgress: GenerationProgressResponse | null = null;

    while (Date.now() < deadline) {
      const progress = await this.getGenerationProgress({ generationId, apiProjectId, requestOptions });
      lastProgress = progress;
      await reportProgress(progress, onProgress, showProgress);

      if (progress.status === "complete") {
        return progress;
      }
      if (progress.status === "failed") {
        throw new DiffioApiError(
          "Generation failed" +
            ` (preProcessing=${progress.preProcessing.status},` +
            ` inference=${progress.inference.status},` +
            ` error=${progress.error},` +
            ` details=${progress.errorDetails})`
        );
      }

      await sleepSeconds(pollInterval);
    }

    throw new DiffioApiError(
      "Timed out waiting for generation completion" +
        ` (lastStatus=${lastProgress ? lastProgress.status : "unknown"})`
    );
  }

  async getGenerationDownload(options: {
    generationId: string;
    apiProjectId: string;
    downloadType?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<GenerationDownloadResponse> {
    const { generationId, apiProjectId, downloadType, requestOptions } = options;
    const payload: Record<string, unknown> = { generationId, apiProjectId };
    if (downloadType != null) {
      if (downloadType !== "audio" && downloadType !== "video") {
        throw new DiffioApiError("downloadType must be audio or video");
      }
      payload.downloadType = downloadType;
    }
    const response = await this._requestJson("POST", "get_generation_download", payload, requestOptions);
    return parseGenerationDownloadResponse(response);
  }

  async sendWebhookTestEvent(options: {
    eventType: string;
    mode: string;
    apiKeyId?: string;
    samplePayload?: Record<string, unknown>;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<WebhookTestEventResponse> {
    const { eventType, mode, apiKeyId, samplePayload, requestOptions } = options;
    if (!WEBHOOK_EVENT_TYPES.includes(eventType)) {
      throw new DiffioApiError("eventType is not supported");
    }
    if (!WEBHOOK_MODES.includes(mode)) {
      throw new DiffioApiError("mode must be test or live");
    }
    if (samplePayload != null && (typeof samplePayload !== "object" || Array.isArray(samplePayload))) {
      throw new DiffioApiError("samplePayload must be an object");
    }

    const payload: Record<string, unknown> = { eventType, mode };
    if (apiKeyId != null) {
      payload.apiKeyId = apiKeyId;
    }
    if (samplePayload != null) {
      payload.samplePayload = samplePayload;
    }

    const response = await this._requestJson("POST", "webhooks/send_test_event", payload, requestOptions);
    return parseWebhookTestEventResponse(response);
  }

  async restoreAudio(options: {
    filePath: string;
    contentType?: string;
    contentLength?: number;
    fileFormat?: string;
    model?: string;
    sampling?: Record<string, unknown>;
    projectParams?: Record<string, unknown>;
    generationParams?: Record<string, unknown>;
    downloadType?: string;
    pollInterval?: number;
    timeout?: number;
    timeoutInSeconds?: number;
    onProgress?: (progress: GenerationProgressResponse) => void | Promise<void>;
    showProgress?: boolean;
    requestOptions?: DiffioClient.RequestOptions;
    progressRequestOptions?: DiffioClient.RequestOptions;
    downloadRequestOptions?: DiffioClient.RequestOptions;
    raiseOnError?: boolean;
  }): Promise<[Uint8Array | null, RestoreMetadata]> {
    const metadata = initRestoreMetadata();
    metadata.downloadType = options.downloadType ?? "audio";

    const resolvedProgressOptions = options.progressRequestOptions ?? options.requestOptions;
    const resolvedDownloadOptions = options.downloadRequestOptions ?? options.requestOptions;

    let result: AudioIsolationResult | null = null;
    try {
      result = await this.audioIsolationIsolate({
        filePath: options.filePath,
        contentType: options.contentType,
        contentLength: options.contentLength,
        fileFormat: options.fileFormat,
        model: options.model,
        sampling: options.sampling,
        projectParams: options.projectParams,
        generationParams: options.generationParams,
        requestOptions: options.requestOptions
      });
    } catch (error) {
      metadata.stage = "isolate";
      setRestoreError(metadata, error);
      if (options.raiseOnError) {
        attachRestoreMetadata(error, metadata);
        throw error;
      }
      return [null, metadata];
    }

    metadata.project = result.project;
    metadata.generation = result.generation;
    metadata.apiProjectId = result.project.apiProjectId;
    metadata.generationId = result.generation.generationId;
    metadata.stage = "generation";

    let progress: GenerationProgressResponse | null = null;
    try {
      progress = await this.waitForGeneration({
        generationId: result.generation.generationId,
        apiProjectId: result.project.apiProjectId,
        pollInterval: options.pollInterval,
        timeout: options.timeout,
        timeoutInSeconds: options.timeoutInSeconds,
        onProgress: options.onProgress,
        showProgress: options.showProgress,
        requestOptions: resolvedProgressOptions
      });
    } catch (error) {
      metadata.stage = "progress";
      try {
        progress = await this.getGenerationProgress({
          generationId: result.generation.generationId,
          apiProjectId: result.project.apiProjectId,
          requestOptions: resolvedProgressOptions
        });
      } catch {
        progress = null;
      }
      metadata.progress = progress;
      metadata.status = progress?.status ?? null;
      setRestoreError(metadata, error);
      if (progress) {
        metadata.error = progress.error ?? String(error);
        metadata.errorDetails = progress.errorDetails ?? null;
      }
      if (options.raiseOnError) {
        attachRestoreMetadata(error, metadata);
        throw error;
      }
      return [null, metadata];
    }

    metadata.progress = progress;
    metadata.status = progress.status;
    metadata.error = progress.error ?? null;
    metadata.errorDetails = progress.errorDetails ?? null;

    metadata.stage = "download_info";
    let download: GenerationDownloadResponse;
    try {
      download = await this.getGenerationDownload({
        generationId: result.generation.generationId,
        apiProjectId: result.project.apiProjectId,
        downloadType: options.downloadType ?? "audio",
        requestOptions: resolvedDownloadOptions
      });
    } catch (error) {
      setRestoreError(metadata, error);
      if (options.raiseOnError) {
        attachRestoreMetadata(error, metadata);
        throw error;
      }
      return [null, metadata];
    }

    metadata.download = download;
    metadata.downloadType = download.downloadType;
    metadata.downloadUrl = download.downloadUrl;
    metadata.fileName = download.fileName;
    metadata.mimeType = download.mimeType;

    metadata.stage = "download";
    let content: Uint8Array;
    try {
      content = await this._downloadBinary(download.downloadUrl, resolvedDownloadOptions);
    } catch (error) {
      setRestoreError(metadata, error);
      if (options.raiseOnError) {
        attachRestoreMetadata(error, metadata);
        throw error;
      }
      return [null, metadata];
    }

    metadata.stage = "complete";
    metadata.ok = true;
    return [content, metadata];
  }

  async restore(options: Parameters<DiffioClient["restoreAudio"]>[0]): Promise<[Uint8Array | null, RestoreMetadata]> {
    return this.restoreAudio(options);
  }

  async audioIsolationIsolate(options: {
    filePath: string;
    contentType?: string;
    contentLength?: number;
    fileFormat?: string;
    model?: string;
    sampling?: Record<string, unknown>;
    projectParams?: Record<string, unknown>;
    generationParams?: Record<string, unknown>;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<AudioIsolationResult> {
    const project = await this.createProject({
      filePath: options.filePath,
      contentType: options.contentType,
      contentLength: options.contentLength,
      params: options.projectParams,
      fileFormat: options.fileFormat,
      requestOptions: options.requestOptions
    });

    const generation = await this.createGeneration({
      apiProjectId: project.apiProjectId,
      model: options.model,
      sampling: options.sampling,
      params: options.generationParams,
      requestOptions: options.requestOptions
    });

    return createAudioIsolationResult(project, generation);
  }

  private async _downloadBinary(
    downloadUrl: string,
    requestOptions?: DiffioClient.RequestOptions
  ): Promise<Uint8Array> {
    const extraHeaders: Record<string, string> = {};
    if (isStorageEmulatorUrl(downloadUrl)) {
      extraHeaders.Authorization = "Bearer owner";
    }
    const response = await this._requestBinary(
      "GET",
      downloadUrl,
      undefined,
      requestOptions,
      extraHeaders,
      true
    );
    return response as Uint8Array;
  }

  private async _requestJson(
    method: string,
    path: string,
    payload: Record<string, unknown>,
    requestOptions?: DiffioClient.RequestOptions
  ): Promise<any> {
    const { url, headers, timeoutMs, maxRetries, retryBackoff, retryStatusCodes, fetchFn, abortSignal } =
      await this._buildRequest(method, path, requestOptions, {
        "Content-Type": "application/json"
      });

    const requestBody = JSON.stringify(payload);

    const makeRequest = () =>
      fetchWithTimeout(fetchFn, url, {
        method,
        headers,
        body: requestBody
      }, timeoutMs, abortSignal);

    const response = await requestWithRetries(
      makeRequest,
      { maxRetries, retryBackoff, retryStatusCodes }
    );

    return parseJsonResponse(response);
  }

  private async _requestBinary(
    method: string,
    urlOrPath: string,
    body: unknown,
    requestOptions?: DiffioClient.RequestOptions,
    extraHeaders?: Record<string, string>,
    isAbsoluteUrl = false
  ): Promise<Uint8Array | void> {
    const { url, headers, timeoutMs, maxRetries, retryBackoff, retryStatusCodes, fetchFn, abortSignal } =
      await this._buildRequest(method, urlOrPath, requestOptions, extraHeaders, isAbsoluteUrl);

    const requestInit: RequestInit = {
      method,
      headers,
      body: body as BodyInit,
      signal: abortSignal
    };

    if (body && isNodeReadable(body)) {
      (requestInit as { duplex?: "half" }).duplex = "half";
    }

    const makeRequest = () =>
      fetchWithTimeout(fetchFn, url, requestInit, timeoutMs, abortSignal);

    const response = await requestWithRetries(makeRequest, { maxRetries, retryBackoff, retryStatusCodes });

    if (method === "GET") {
      return parseBinaryResponse(response);
    }
    await parseJsonResponse(response);
  }

  private async _buildRequest(
    method: string,
    path: string,
    requestOptions?: DiffioClient.RequestOptions,
    extraHeaders?: Record<string, string>,
    isAbsoluteUrl = false
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    maxRetries: number;
    retryBackoff: number;
    retryStatusCodes: number[];
    fetchFn: typeof fetch;
    abortSignal?: AbortSignal;
  }> {
    const { baseUrl, apiPrefix } = await resolveBaseUrl(this._options.baseUrl);
    const apiKey = requestOptions?.apiKey ?? (await Supplier.get(this._options.apiKey));
    if (!apiKey && !isAbsoluteUrl) {
      throw new DiffioApiError("apiKey is required");
    }

    const baseHeaders = isAbsoluteUrl ? undefined : this._options.headers;
    const authHeaders =
      !isAbsoluteUrl && apiKey ? mergeOnlyDefinedHeaders({ Authorization: `Bearer ${apiKey}` }) : undefined;
    const mergedHeaders = mergeHeaders(baseHeaders, authHeaders, requestOptions?.headers, extraHeaders);
    const headers = await resolveHeaders(mergedHeaders);

    const timeoutSeconds =
      requestOptions?.timeoutInSeconds ??
      requestOptions?.timeout ??
      this._options.timeoutInSeconds ??
      this._options.timeout ??
      DEFAULT_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;

    const maxRetries = requestOptions?.maxRetries ?? this._options.maxRetries ?? 0;
    const retryBackoff = requestOptions?.retryBackoff ?? this._options.retryBackoff ?? DEFAULT_RETRY_BACKOFF;
    const retryStatusCodes =
      requestOptions?.retryStatusCodes ?? this._options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES;

    const fetchFn = this._options.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new DiffioApiError("fetch is not available in this runtime");
    }

    const requestPath = path.replace(/^\/+/, "");
    const url = isAbsoluteUrl
      ? path
      : join(baseUrl, apiPrefix ? `${apiPrefix}/${requestPath}` : requestPath);

    return {
      url,
      headers,
      timeoutMs,
      maxRetries,
      retryBackoff,
      retryStatusCodes,
      fetchFn,
      abortSignal: requestOptions?.abortSignal
    };
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { name?: string }).name === "AbortError";
}

function createAbortSignal(timeoutMs?: number, externalSignal?: AbortSignal): {
  signal?: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  if (!timeoutMs && !externalSignal) {
    return { cleanup: () => undefined, didTimeout: () => false };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const abortListener = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  if (timeoutMs != null) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortListener);
    }
  };

  return { signal: controller.signal, cleanup, didTimeout: () => timedOut };
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs?: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const { signal, cleanup, didTimeout } = createAbortSignal(timeoutMs, externalSignal);
  try {
    return await fetchFn(url, { ...init, signal });
  } catch (error) {
    if (isAbortError(error) && didTimeout()) {
      throw new DiffioTimeoutError("Request timed out");
    }
    throw error;
  } finally {
    cleanup();
  }
}

function parseJsonResponse(response: Response): Promise<any> {
  if (response.ok) {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    if (response.status === 204) {
      return Promise.resolve({});
    }
    return response.text().then((text) => {
      if (!text) {
        return {};
      }
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    });
  }

  return parseErrorResponse(response).then((errorBody) => {
    const message = getErrorMessage(errorBody, response.status);
    throw new DiffioApiError(message, { statusCode: response.status, responseBody: errorBody });
  });
}

async function parseBinaryResponse(response: Response): Promise<Uint8Array> {
  if (response.ok) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  const errorBody = await parseErrorResponse(response);
  const message = getErrorMessage(errorBody, response.status);
  throw new DiffioApiError(message, { statusCode: response.status, responseBody: errorBody });
}

async function parseErrorResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text();
  return text || null;
}

function getErrorMessage(body: any, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: unknown }).error;
    if (message) {
      return String(message);
    }
  }
  return `Request failed with status ${status}`;
}

async function resolveBaseUrl(baseUrlSupplier?: Supplier<string>): Promise<{ baseUrl: string; apiPrefix: string }> {
  const envBase = typeof process !== "undefined" ? process.env.DIFFIO_API_BASE_URL : undefined;
  const resolvedBase = (await Supplier.get(baseUrlSupplier)) ?? envBase ?? DEFAULT_BASE_URL;
  const trimmed = resolvedBase.replace(/\/+$/, "");
  const apiPrefix = trimmed.endsWith(`/${API_PREFIX}`) ? "" : API_PREFIX;
  return { baseUrl: trimmed, apiPrefix };
}

function guessContentType(filePath: string): string | undefined {
  const guessed = lookupMimeType(filePath);
  if (typeof guessed === "string") {
    return guessed;
  }
  return undefined;
}

function isStorageEmulatorUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(host)) {
      if (!parsed.port || port === 9199) {
        return true;
      }
    }

    const envHost =
      typeof process !== "undefined"
        ? process.env.STORAGE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST
        : undefined;
    if (!envHost) {
      return false;
    }
    const normalized = envHost.startsWith("http://") || envHost.startsWith("https://") ? envHost : `http://${envHost}`;
    const emulatorParsed = new URL(normalized);
    const emulatorHost = emulatorParsed.hostname.toLowerCase();
    const emulatorPort = emulatorParsed.port
      ? Number(emulatorParsed.port)
      : emulatorParsed.protocol === "https:"
        ? 443
        : 80;

    return host === emulatorHost && port === emulatorPort;
  } catch {
    return false;
  }
}

function isNodeReadable(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value) && typeof value === "object" && typeof (value as NodeJS.ReadableStream).pipe === "function";
}

async function createFileReadStream(filePath: string): Promise<NodeJS.ReadableStream> {
  const fs = await import("node:fs");
  return fs.createReadStream(filePath);
}

function getFileSize(filePath: string): number {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.statSync(filePath).size;
}

function getBaseName(filePath: string): string {
  const path = require("node:path") as typeof import("node:path");
  return path.basename(filePath);
}

function initRestoreMetadata(): RestoreMetadata {
  return {
    ok: false,
    stage: "start",
    apiProjectId: null,
    generationId: null,
    project: null,
    generation: null,
    progress: null,
    download: null,
    downloadType: null,
    downloadUrl: null,
    fileName: null,
    mimeType: null,
    status: null,
    error: null,
    errorDetails: null,
    exceptionType: null,
    exceptionMessage: null
  };
}

function setRestoreError(metadata: RestoreMetadata, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  metadata.error = message;
  metadata.exceptionType = error instanceof Error ? error.name : typeof error;
  metadata.exceptionMessage = message;
}

function attachRestoreMetadata(error: unknown, metadata: RestoreMetadata): void {
  if (error && typeof error === "object") {
    try {
      (error as { restoreInfo?: RestoreMetadata }).restoreInfo = metadata;
    } catch {
      return;
    }
  }
}

async function reportProgress(
  progress: GenerationProgressResponse,
  onProgress?: (progress: GenerationProgressResponse) => void | Promise<void>,
  showProgress?: boolean
): Promise<void> {
  if (onProgress) {
    await onProgress(progress);
  }
  if (showProgress) {
    // eslint-disable-next-line no-console
    console.log(formatProgress(progress));
  }
}

function formatProgress(progress: GenerationProgressResponse): string {
  const parts: string[] = [];
  if (progress.preProcessing) {
    parts.push(`pre=${progress.preProcessing.status}:${progress.preProcessing.progress}%`);
  }
  if (progress.inference) {
    parts.push(`inf=${progress.inference.status}:${progress.inference.progress}%`);
  }
  if (progress.restoredVideo) {
    parts.push(`vid=${progress.restoredVideo.status}:${progress.restoredVideo.progress}%`);
  }
  const joined = parts.join(", ");
  if (joined) {
    return `${progress.status} (${joined})`;
  }
  return progress.status;
}

async function sleepSeconds(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
