import type { BaseClientOptions, BaseRequestOptions, NormalizedClientOptions } from "./BaseClient";
import { normalizeClientOptions } from "./BaseClient";
import { mergeHeaders, mergeOnlyDefinedHeaders, resolveHeaders } from "./core/headers";
import { Supplier } from "./core/supplier";
import { join } from "./core/url";
import { requestWithRetries } from "./core/retry";
import { DiffioApiError, DiffioTimeoutError, DiffioUploadError } from "./errors";
import {
  parseEdgeUploadSession,
  uploadProjectMediaToEdge,
  type EdgeUploadHttpRequest,
  type EdgeUploadHttpResponse
} from "./core/edgeUpload";
import {
  createAudioIsolationResult,
  parseAccountSettingsResponse,
  parseApiKeyResponse,
  parseApiKeysListResponse,
  createProjectUploadResult,
  parseCompleteProjectUploadResponse,
  parseCreateGenerationResponse,
  parseGenerationDownloadResponse,
  parseGenerationProgressResponse,
  parseListProjectGenerationsResponse,
  parseListProjectsResponse,
  parseUsageSummaryResponse,
  parseWebhookConfigureResponse,
  parseWebhookTestEventResponse
} from "./api/serialization";
import type {
  AccountSettingsResponse,
  ApiKeyResponse,
  ApiKeysListResponse,
  AudioIsolationResult,
  CompleteProjectUploadResponse,
  CreateGenerationResponse,
  CreateProjectResponse,
  GenerationDownloadResponse,
  GenerationProgressResponse,
  ListProjectGenerationsResponse,
  ListProjectsResponse,
  ModelKey,
  RestoreMetadata,
  UsageSummaryResponse,
  WebhookConfigureResponse,
  WebhookTestEventResponse
} from "./api/types";
import {
  AccountClient,
  ApiKeysClient,
  AudioIsolationClient,
  GenerationsClient,
  ProjectsClient,
  UsageClient,
  WebhooksClient
} from "./api/resources";
import { lookup as lookupMimeType } from "mime-types";

const DEFAULT_BASE_URL = "https://api.diffio.ai";
const API_PREFIX = "v1";
/** Generation endpoint for each supported model, as api/model_registry.json in diffio-ui lists them. */
const MODEL_ENDPOINTS = {
  "diffio-4.5-flash": "diffio-4.5-flash-generation",
  "diffio-4.5-pro": "diffio-4.5-pro-generation"
} as const satisfies Record<ModelKey, string>;
/** The registry's `freeDefault` model; Pro is paid-only, so it cannot be the default for every key. */
const DEFAULT_MODEL_KEY: ModelKey = "diffio-4.5-flash";
const SUPPORTED_MODEL_KEYS = Object.keys(MODEL_ENDPOINTS) as ModelKey[];
/** Per-request timeout for one edge upload call; a 32 MiB part needs about 1 Mbit/s to finish in time. */
const DEFAULT_EDGE_UPLOAD_TIMEOUT_SECONDS = 300;
/** complete_project_upload is idempotent, so it is retried even when the client disables retries by default. */
const DEFAULT_COMPLETE_UPLOAD_MAX_RETRIES = 3;
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const DEFAULT_RETRY_BACKOFF = 0.5;
const DEFAULT_TIMEOUT_SECONDS = 60;
/** How long waitForGeneration polls by default; fleet generations can queue and run for minutes (matches the Python SDK). */
const DEFAULT_GENERATION_WAIT_TIMEOUT_SECONDS = 600;
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
  public readonly account: AccountClient;
  public readonly apiKeys: ApiKeysClient;
  public readonly usage: UsageClient;
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
    this.account = new AccountClient(this);
    this.apiKeys = new ApiKeysClient(this);
    this.usage = new UsageClient(this);
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
    const apiProjectId = typeof response?.apiProjectId === "string" ? response.apiProjectId : undefined;
    const session = parseEdgeUploadSession(response?.upload);
    if (!apiProjectId || !session) {
      throw new DiffioUploadError(
        "upload/invalid-response",
        "create_project did not return an upload session (apiProjectId and upload are required).",
        { responseBody: response, apiProjectId }
      );
    }

    try {
      const sizeBytes = getFileSize(filePath);
      const fileHandle = await openFileForReading(filePath);
      try {
        await uploadProjectMediaToEdge({
          session,
          sizeBytes,
          readPartBytes: (startByte, endByte) => readFileBytes(fileHandle, startByte, endByte),
          sendEdgeRequest: (request) => this._sendEdgeUploadRequest(request, requestOptions)
        });
      } finally {
        await fileHandle.close();
      }
    } catch (error) {
      if (error instanceof DiffioUploadError) {
        error.apiProjectId = error.apiProjectId ?? apiProjectId;
      }
      throw error;
    }

    const uploadCompletion = await this.completeProjectUpload({ apiProjectId, requestOptions });
    return createProjectUploadResult(response, session, uploadCompletion);
  }

  /**
   * Confirms that a project's edge upload landed and starts preprocessing. createProject calls it;
   * call it yourself only to finish an upload whose confirmation failed. It is idempotent.
   */
  async completeProjectUpload(options: {
    apiProjectId: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<CompleteProjectUploadResponse> {
    const { apiProjectId, requestOptions } = options;
    if (!apiProjectId) {
      throw new DiffioApiError("apiProjectId is required");
    }
    const completeRequestOptions: DiffioClient.RequestOptions = {
      ...requestOptions,
      maxRetries: requestOptions?.maxRetries ?? this._options.maxRetries ?? DEFAULT_COMPLETE_UPLOAD_MAX_RETRIES
    };
    const response = await this._requestJson(
      "POST",
      "complete_project_upload",
      { apiProjectId },
      completeRequestOptions
    );
    return parseCompleteProjectUploadResponse(response);
  }

  /** Sends one edge upload call with the session's upload token; never the API key or SDK default headers. */
  private async _sendEdgeUploadRequest(
    request: EdgeUploadHttpRequest,
    requestOptions?: DiffioClient.RequestOptions
  ): Promise<EdgeUploadHttpResponse> {
    const fetchFn = this._options.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new DiffioApiError("fetch is not available in this runtime");
    }
    const timeoutSeconds =
      requestOptions?.timeoutInSeconds ?? requestOptions?.timeout ?? DEFAULT_EDGE_UPLOAD_TIMEOUT_SECONDS;
    // A Uint8Array or string body has a known length, so fetch sends the Content-Length the edge requires.
    const response = await fetchWithTimeout(
      fetchFn,
      request.url,
      {
        method: request.method,
        headers: {
          Authorization: `Bearer ${request.bearerToken}`,
          "Content-Type": request.contentType
        },
        body: request.body as BodyInit
      },
      timeoutSeconds * 1000,
      requestOptions?.abortSignal
    );
    return { status: response.status, bodyText: await response.text() };
  }

  /** Retries generation admission only when the caller supplies a nonblank idempotency key. */
  async createGeneration(options: {
    apiProjectId: string;
    model?: ModelKey;
    sampling?: Record<string, unknown>;
    params?: Record<string, unknown>;
    idempotencyKey?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<CreateGenerationResponse> {
    const { apiProjectId, model = DEFAULT_MODEL_KEY, sampling, params, idempotencyKey, requestOptions } = options;
    const endpoint = Object.prototype.hasOwnProperty.call(MODEL_ENDPOINTS, model) ? MODEL_ENDPOINTS[model] : undefined;
    if (!endpoint) {
      throw new DiffioApiError(`Unsupported model: ${model}. Use ${SUPPORTED_MODEL_KEYS.join(" or ")}.`);
    }

    const payload: Record<string, unknown> = { apiProjectId };
    if (sampling != null) {
      payload.sampling = sampling;
    }
    if (params) {
      payload.params = params;
    }
    if (idempotencyKey != null) {
      payload.idempotencyKey = idempotencyKey;
    }

    const generationRequestOptions = idempotencyKey?.trim()
      ? requestOptions
      : { ...requestOptions, maxRetries: 0 };
    const response = await this._requestJson("POST", endpoint, payload, generationRequestOptions);
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

  /** Waits for media completion and settlement; transcription may still be pending or unavailable. */
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
    const timeoutSeconds = timeoutInSeconds ?? timeout ?? DEFAULT_GENERATION_WAIT_TIMEOUT_SECONDS;
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
      if (downloadType !== "audio" && downloadType !== "video" && downloadType !== "transcript") {
        throw new DiffioApiError("downloadType must be audio, video, or transcript");
      }
      payload.downloadType = downloadType;
    }
    const response = await this._requestJson("POST", "get_generation_download", payload, requestOptions);
    return parseGenerationDownloadResponse(response);
  }

  async getAccountSettings(options: {
    requestOptions?: DiffioClient.RequestOptions;
  } = {}): Promise<AccountSettingsResponse> {
    const response = await this._requestJson("POST", "account/settings/get", {}, options.requestOptions);
    return parseAccountSettingsResponse(response);
  }

  async updateAccountSettings(options: {
    billingPolicy: Record<string, unknown>;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<AccountSettingsResponse> {
    const { billingPolicy, requestOptions } = options;
    if (!billingPolicy || typeof billingPolicy !== "object" || Array.isArray(billingPolicy)) {
      throw new DiffioApiError("billingPolicy must be an object");
    }
    const response = await this._requestJson("POST", "account/settings/update", { billingPolicy }, requestOptions);
    return parseAccountSettingsResponse(response);
  }

  async createApiKey(options: {
    label: string;
    scopes: string[];
    resourceBounds?: Record<string, unknown>;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<ApiKeyResponse> {
    const { label, scopes, resourceBounds, requestOptions } = options;
    if (!label) {
      throw new DiffioApiError("label is required");
    }
    if (!Array.isArray(scopes)) {
      throw new DiffioApiError("scopes must be an array");
    }
    const response = await this._requestJson(
      "POST",
      "api_keys/create",
      { label, scopes, resourceBounds: resourceBounds ?? {} },
      requestOptions
    );
    return parseApiKeyResponse(response);
  }

  async listApiKeys(options: { requestOptions?: DiffioClient.RequestOptions } = {}): Promise<ApiKeysListResponse> {
    const response = await this._requestJson("POST", "api_keys/list", {}, options.requestOptions);
    return parseApiKeysListResponse(response);
  }

  async rotateApiKey(options: {
    keyId: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<ApiKeyResponse> {
    const { keyId, requestOptions } = options;
    if (!keyId) {
      throw new DiffioApiError("keyId is required");
    }
    const response = await this._requestJson("POST", "api_keys/rotate", { keyId }, requestOptions);
    return parseApiKeyResponse(response);
  }

  async revokeApiKey(options: {
    keyId: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<ApiKeyResponse> {
    const { keyId, requestOptions } = options;
    if (!keyId) {
      throw new DiffioApiError("keyId is required");
    }
    const response = await this._requestJson("POST", "api_keys/revoke", { keyId }, requestOptions);
    return parseApiKeyResponse(response);
  }

  async getUsageSummary(options: {
    apiKeyId?: string;
    requestOptions?: DiffioClient.RequestOptions;
  } = {}): Promise<UsageSummaryResponse> {
    const payload: Record<string, unknown> = {};
    if (options.apiKeyId != null) {
      payload.apiKeyId = options.apiKeyId;
    }
    const response = await this._requestJson("POST", "usage/summary", payload, options.requestOptions);
    return parseUsageSummaryResponse(response);
  }

  async configureWebhook(options: {
    mode: string;
    url: string;
    eventTypes: string[];
    apiKeyId?: string;
    requestOptions?: DiffioClient.RequestOptions;
  }): Promise<WebhookConfigureResponse> {
    const { mode, url, eventTypes, apiKeyId, requestOptions } = options;
    if (!WEBHOOK_MODES.includes(mode)) {
      throw new DiffioApiError("mode must be test or live");
    }
    if (!url) {
      throw new DiffioApiError("url is required");
    }
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      throw new DiffioApiError("eventTypes must be a non-empty array");
    }
    const payload: Record<string, unknown> = { mode, url, eventTypes };
    if (apiKeyId != null) {
      payload.apiKeyId = apiKeyId;
    }
    const response = await this._requestJson("POST", "webhooks/configure", payload, requestOptions);
    return parseWebhookConfigureResponse(response);
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
    model?: ModelKey;
    sampling?: Record<string, unknown>;
    projectParams?: Record<string, unknown>;
    generationParams?: Record<string, unknown>;
    idempotencyKey?: string;
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
        idempotencyKey: options.idempotencyKey,
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
    model?: ModelKey;
    sampling?: Record<string, unknown>;
    projectParams?: Record<string, unknown>;
    generationParams?: Record<string, unknown>;
    idempotencyKey?: string;
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
      idempotencyKey: options.idempotencyKey,
      requestOptions: options.requestOptions
    });

    return createAudioIsolationResult(project, generation);
  }

  private async _downloadBinary(
    downloadUrl: string,
    requestOptions?: DiffioClient.RequestOptions
  ): Promise<Uint8Array> {
    // The download URL is a signed edge media URL; it needs no Authorization header.
    const response = await this._requestBinary("GET", downloadUrl, () => undefined, requestOptions, {}, true);
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
    bodyFactory: () => unknown | Promise<unknown>,
    requestOptions?: DiffioClient.RequestOptions,
    extraHeaders?: Record<string, string>,
    isAbsoluteUrl = false
  ): Promise<Uint8Array | void> {
    const { url, headers, timeoutMs, maxRetries, retryBackoff, retryStatusCodes, fetchFn, abortSignal } =
      await this._buildRequest(method, urlOrPath, requestOptions, extraHeaders, isAbsoluteUrl);

    const makeRequest = async () => {
      const body = await bodyFactory();
      const requestInit: RequestInit = {
        method,
        headers,
        body: body as BodyInit,
        signal: abortSignal
      };

      if (body && isNodeReadable(body)) {
        (requestInit as { duplex?: "half" }).duplex = "half";
      }

      try {
        return await fetchWithTimeout(fetchFn, url, requestInit, timeoutMs, abortSignal);
      } finally {
        destroyNodeReadable(body);
      }
    };

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
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
    if (error) {
      return String(error);
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

function isNodeReadable(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value) && typeof value === "object" && typeof (value as NodeJS.ReadableStream).pipe === "function";
}

function destroyNodeReadable(value: unknown): void {
  const destroy = isNodeReadable(value)
    ? (value as NodeJS.ReadableStream & { destroy?: () => void }).destroy
    : undefined;
  if (destroy) {
    destroy.call(value);
  }
}

type MediaFileHandle = import("node:fs/promises").FileHandle;

async function openFileForReading(filePath: string): Promise<MediaFileHandle> {
  const fs = await import("node:fs/promises");
  return fs.open(filePath, "r");
}

/** Reads bytes [startByte, endByte) of an open file into one buffer, looping over short reads. */
async function readFileBytes(fileHandle: MediaFileHandle, startByte: number, endByte: number): Promise<Uint8Array> {
  const length = endByte - startByte;
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, startByte + offset);
    if (bytesRead === 0) {
      throw new DiffioUploadError("upload/invalid-response", "The file became shorter while it was uploading.");
    }
    offset += bytesRead;
  }
  return buffer;
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
  if (error instanceof DiffioApiError) {
    metadata.statusCode = error.statusCode;
    metadata.responseBody = error.responseBody;
  }
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
