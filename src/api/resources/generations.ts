import { fetchWithTimeout, type RequestOptions, type Transport } from "../../core/transport";
import { Page, PagePromise, type ListResponse } from "../../core/pagination";
import { queryString, segment } from "../../core/url";
import { pollUntil, type WaitOptions } from "../../core/poll";
import { retryDelayMs, sleep, DEFAULT_RETRY_STATUS_CODES } from "../../core/retry";
import { writeResponseToFile } from "../../core/files";
import { DiffioApiError, DiffioConnectionError, DiffioError } from "../../errors";
import type {
  Generation,
  GenerationCreateParams,
  GenerationFileName,
  GenerationMedia,
  GenerationMediaParams,
  ListParams
} from "../types";

/** How long `wait` polls by default; long recordings queue and run for a while. */
export const DEFAULT_GENERATION_WAIT_TIMEOUT_SECONDS = 3600;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 600;

export const generationPath = (projectId: string, generationId: string): string =>
  `/projects/${segment(projectId, "projectId")}/generations/${segment(generationId, "generationId")}`;

export interface GenerationDownloadOptions extends RequestOptions {
  /** Which file of `GET .../media` to fetch (default `audio`, the restored audio). */
  file?: GenerationFileName;
  /** Node: write the file here (streamed) instead of returning its bytes. */
  path?: string;
}

/** What `download` returns. `data` holds the bytes when no `path` was given. */
export interface GenerationDownload {
  file: string;
  url: string;
  path: string | null;
  data: Uint8Array | null;
  size_bytes: number;
  content_type: string | null;
}

export class GenerationsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /v2/projects/{project_id}/generations`: starts a restore with `model` (`diffio-flash`,
   * `diffio-pro`, ...). Sent before the upload is ready it waits in `queued` and starts by itself.
   */
  async create(projectId: string, params: GenerationCreateParams, options?: RequestOptions): Promise<Generation> {
    if (!params || typeof params.model !== "string" || !params.model.trim()) throw new TypeError("model is required");
    return this.transport.request<Generation>({
      method: "POST",
      path: `/projects/${segment(projectId, "projectId")}/generations`,
      body: params,
      idempotent: false,
      acceptsIdempotencyKey: true,
      options
    });
  }

  /** `GET /v2/projects/{project_id}/generations`: newest first; `for await` walks every page. */
  list(projectId: string, params: ListParams = {}, options?: RequestOptions): PagePromise<Generation> {
    const path = `/projects/${segment(projectId, "projectId")}/generations`;
    return PagePromise.from(async () => {
      const response = await this.transport.request<ListResponse<Generation>>({
        method: "GET",
        path: `${path}${queryString({ limit: params.limit, cursor: params.cursor })}`,
        idempotent: true,
        options
      });
      return new Page(response, async (cursor) => this.list(projectId, { ...params, cursor }, options));
    });
  }

  /** `GET /v2/projects/{project_id}/generations/{generation_id}`. */
  async get(projectId: string, generationId: string, options?: RequestOptions): Promise<Generation> {
    return this.transport.request<Generation>({
      method: "GET",
      path: generationPath(projectId, generationId),
      idempotent: true,
      options
    });
  }

  /**
   * Polls `get` until the generation is `complete` and returns it. Throws DiffioResourceFailedError
   * (with `error.code`) when it fails and DiffioTimeoutError after `timeout` seconds (default 3600).
   */
  async wait(
    projectId: string,
    generationId: string,
    options: WaitOptions<Generation> & RequestOptions = {}
  ): Promise<Generation> {
    const { timeout, pollInterval, onProgress, ...requestOptions } = options;
    return pollUntil(
      () => this.get(projectId, generationId, requestOptions),
      (generation) => generation.status === "complete",
      "generation",
      { timeout, pollInterval, onProgress, signal: options.signal, defaultTimeout: DEFAULT_GENERATION_WAIT_TIMEOUT_SECONDS }
    );
  }

  /**
   * `GET .../media`: URLs for the generation's files (`audio`, `video`, `hls_master`, `transcript`,
   * `original`, ...). They need no API key and expire at `expires_at` (6 hours).
   */
  async media(
    projectId: string,
    generationId: string,
    params: GenerationMediaParams = {},
    options?: RequestOptions
  ): Promise<GenerationMedia> {
    return this.transport.request<GenerationMedia>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/media${queryString({ preview_seconds: params.preview_seconds })}`,
      idempotent: true,
      options
    });
  }

  /**
   * Fetches one result file through `media` (default `audio`). With `path` (Node) it streams to that file;
   * otherwise it returns the bytes in `data`.
   */
  async download(
    projectId: string,
    generationId: string,
    options: GenerationDownloadOptions = {}
  ): Promise<GenerationDownload> {
    const { file = "audio", path, ...requestOptions } = options;
    const media = await this.media(projectId, generationId, {}, requestOptions);
    const url = media.files[file];
    if (!url) {
      const available = Object.keys(media.files).sort().join(", ") || "none";
      throw new DiffioError(
        `Generation ${generationId} has no "${file}" file yet (status ${media.status}; files: ${available}).`
      );
    }
    const response = await this.fetchMedia(url, requestOptions);
    const contentType = response.headers.get("content-type");
    if (path) {
      const written = await writeResponseToFile(response, path);
      return { file, url, path, data: null, size_bytes: written, content_type: contentType };
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return { file, url, path: null, data, size_bytes: data.byteLength, content_type: contentType };
  }

  /** GETs a signed media URL (no API key), retrying network failures and 5xx/429. */
  private async fetchMedia(url: string, options: RequestOptions): Promise<Response> {
    const { maxRetries, backoff } = this.transport.retryPolicy(options);
    const timeoutMs = (options.timeout ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchWithTimeout(this.transport.fetchFn, url, { method: "GET" }, timeoutMs, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (attempt < maxRetries) {
          await sleep(retryDelayMs(attempt + 1, backoff), options.signal);
          continue;
        }
        if (error instanceof DiffioError) throw error;
        throw new DiffioConnectionError(`Could not download ${url.split("?")[0]}: ${String((error as Error)?.message ?? error)}`, error);
      }
      if (response.ok) return response;
      if (attempt < maxRetries && DEFAULT_RETRY_STATUS_CODES.includes(response.status)) {
        await response.arrayBuffer().catch(() => undefined);
        await sleep(retryDelayMs(attempt + 1, backoff, response.headers.get("retry-after")), options.signal);
        continue;
      }
      const text = await response.text().catch(() => "");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const error = body && typeof body === "object" ? (body as { error?: { code?: string; message?: string } }).error : undefined;
      throw new DiffioApiError({
        status: response.status,
        code: error?.code ?? (response.status === 404 ? "not_found" : "download_failed"),
        message: error?.message ?? `The media download failed with HTTP ${response.status}.`,
        headers: response.headers,
        body
      });
    }
  }
}
