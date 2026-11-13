import { Transport, type RequestOptions } from "./core/transport";
import type { HeaderRecord } from "./core/headers";
import type { Supplier } from "./core/supplier";
import { guessContentType, resolveFileInput, type FileInput } from "./core/files";
import type { WaitOptions } from "./core/poll";
import { DiffioError } from "./errors";
import {
  AssistantResource,
  EditsResource,
  ExportsResource,
  GenerationsResource,
  MixResource,
  ModelsResource,
  ProjectsResource,
  SharesResource,
  TranscriptsResource,
  UsageResource,
  WebhooksResource
} from "./api/resources";
import type { Generation, GenerationFileName, ModelName, Project } from "./api/types";

export declare namespace DiffioClient {
  export interface Options {
    /** API key (`diffio_live_...`). Default: the `DIFFIO_API_KEY` environment variable. */
    apiKey?: Supplier<string | undefined>;
    /**
     * API host, such as `https://api.diffio.ai` (the default); `/v2` is added when missing.
     * Default: the `DIFFIO_API_BASE_URL` environment variable, then `https://api.diffio.ai`.
     */
    baseUrl?: Supplier<string | undefined>;
    /** Sent as `Diffio-End-User` on every call (a call's own `endUser` wins). */
    endUser?: string;
    /** Seconds before one HTTP attempt gives up (default 60). */
    timeout?: number;
    /** Retries of idempotent calls after network errors, 408, 429 and 5xx (default 2). */
    maxRetries?: number;
    /** First retry delay in seconds; doubles each retry (default 0.5). */
    retryBackoff?: number;
    retryStatusCodes?: number[];
    /** Extra headers on every API call. */
    headers?: HeaderRecord;
    /** A fetch implementation (default `globalThis.fetch`). */
    fetch?: typeof fetch;
  }

  export type RequestOptions = import("./core/transport").RequestOptions;
}

export interface RestoreAudioParams extends RequestOptions {
  /** A file path (Node), a Blob or File, or bytes. */
  file: FileInput;
  /** Default `diffio-flash`. */
  model?: ModelName;
  /** Node: write the restored file here. Without it the bytes come back in `data`. */
  outputPath?: string;
  /** Needed for bytes; default the path's or File's name. */
  file_name?: string;
  content_type?: string;
  metadata?: Record<string, string>;
  label?: string;
  sampling?: Record<string, unknown>;
  /** Which result file to fetch (default `audio`). */
  downloadFile?: GenerationFileName;
  /** Seconds to wait for the restore (default 3600). */
  timeout?: number;
  /** Seconds between polls (default 2). */
  pollInterval?: number;
  /** Called with the generation on every poll. */
  onProgress?: WaitOptions<Generation>["onProgress"];
  onUploadProgress?: (progress: { bytes_sent: number; bytes_total: number; parts_done: number; parts_total: number }) => void;
}

export interface RestoreAudioResult {
  project: Project;
  generation: Generation;
  /** Where the file was written, when `outputPath` was given. */
  output_path: string | null;
  /** The restored file's bytes, when no `outputPath` was given. */
  data: Uint8Array | null;
  size_bytes: number;
  content_type: string | null;
}

/** Client for Diffio API v2 (`https://api.diffio.ai/v2`). */
export class DiffioClient {
  readonly models: ModelsResource;
  readonly projects: ProjectsResource;
  readonly generations: GenerationsResource;
  readonly edits: EditsResource;
  readonly mix: MixResource;
  readonly exports: ExportsResource;
  readonly transcripts: TranscriptsResource;
  readonly assistant: AssistantResource;
  readonly shares: SharesResource;
  readonly usage: UsageResource;
  readonly webhooks: WebhooksResource;
  protected readonly transport: Transport;

  constructor(options: DiffioClient.Options = {}) {
    this.transport = new Transport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      endUser: options.endUser ?? null,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      retryBackoff: options.retryBackoff,
      retryStatusCodes: options.retryStatusCodes,
      headers: options.headers,
      fetch: options.fetch
    });
    this.models = new ModelsResource(this.transport);
    this.projects = new ProjectsResource(this.transport);
    this.generations = new GenerationsResource(this.transport);
    this.edits = new EditsResource(this.transport);
    this.mix = new MixResource(this.transport);
    this.exports = new ExportsResource(this.transport);
    this.transcripts = new TranscriptsResource(this.transport);
    this.assistant = new AssistantResource(this.transport);
    this.shares = new SharesResource(this.transport);
    this.usage = new UsageResource(this.transport);
    this.webhooks = new WebhooksResource(this.transport);
  }

  /** The v2 base URL calls go to, such as `https://api.diffio.ai/v2`. */
  baseUrl(): Promise<string> {
    return this.transport.baseUrl();
  }

  /**
   * One call: creates a project with a generation, uploads the file, waits for the restore and downloads the
   * result. Throws DiffioResourceFailedError when the restore fails and DiffioTimeoutError on timeout.
   */
  async restoreAudio(params: RestoreAudioParams): Promise<RestoreAudioResult> {
    const {
      file,
      model = "diffio-flash",
      outputPath,
      file_name,
      content_type,
      metadata,
      label,
      sampling,
      downloadFile = "audio",
      timeout,
      pollInterval,
      onProgress,
      onUploadProgress,
      idempotencyKey,
      ...requestOptions
    } = params ?? ({} as RestoreAudioParams);
    if (file === undefined || file === null) throw new TypeError("file is required");

    const resolved = await resolveFileInput(file);
    await resolved.source.close?.();
    const fileName = file_name ?? resolved.file_name;
    if (!fileName) throw new DiffioError("file_name is required when file is bytes or a Blob without a name");
    const contentType = content_type ?? resolved.content_type ?? guessContentType(fileName) ?? undefined;

    const generationParams: { model: ModelName; label?: string; sampling?: Record<string, unknown> } = { model };
    if (label !== undefined) generationParams.label = label;
    if (sampling !== undefined) generationParams.sampling = sampling;
    const created = await this.projects.create(
      {
        file_name: fileName,
        ...(contentType ? { content_type: contentType } : {}),
        size_bytes: resolved.source.sizeBytes,
        ...(metadata ? { metadata } : {}),
        generation: generationParams
      },
      { ...requestOptions, idempotencyKey }
    );

    const project = await this.projects.upload(created, file, { ...requestOptions, onUploadProgress });
    let generationId = created.latest_generation?.id;
    if (!generationId) {
      const generation = await this.generations.create(created.id, generationParams, requestOptions);
      generationId = generation.id;
    }
    const generation = await this.generations.wait(created.id, generationId, {
      ...requestOptions,
      timeout,
      pollInterval,
      onProgress
    });
    const download = await this.generations.download(created.id, generationId, {
      ...requestOptions,
      file: downloadFile,
      path: outputPath
    });
    return {
      project,
      generation,
      output_path: download.path,
      data: download.data,
      size_bytes: download.size_bytes,
      content_type: download.content_type
    };
  }
}
