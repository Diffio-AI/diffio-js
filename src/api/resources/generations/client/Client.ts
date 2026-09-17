import type { DiffioClient } from "../../../../Client";
import type {
  CreateGenerationResponse,
  GenerationDownloadResponse,
  GenerationProgressResponse,
  GenerationArtifact,
  GenerationExportFormat,
  GenerationMixResponse,
  GenerationPlaybackResponse,
  ModelKey
} from "../../../types";

export interface GenerationCreateOptions {
  apiProjectId: string;
  model?: ModelKey;
  sampling?: Record<string, unknown>;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface GenerationProgressOptions {
  generationId: string;
  apiProjectId?: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface GenerationDownloadOptions {
  generationId: string;
  apiProjectId: string;
  downloadType?: string;
  artifact?: GenerationArtifact;
  format?: GenerationExportFormat;
  backgroundGain?: number;
  /** Maximum time to wait for an asynchronous export, in seconds (default 300). */
  exportTimeoutInSeconds?: number;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface GenerationPlaybackOptions {
  generationId: string;
  apiProjectId: string;
  /** First playback chunk to fetch (default 0). */
  startChunk?: number;
  /** Number of signed chunks to fetch, 1–16 (default 8). */
  chunkCount?: number;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface GenerationMixOptions extends Omit<GenerationPlaybackOptions, "startChunk" | "chunkCount"> {
  backgroundGain: number;
  expectedRevision: number;
}

export interface GenerationWaitOptions {
  generationId: string;
  apiProjectId?: string;
  pollInterval?: number;
  timeout?: number;
  timeoutInSeconds?: number;
  onProgress?: (progress: GenerationProgressResponse) => void | Promise<void>;
  showProgress?: boolean;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface GenerationCreateAndWaitOptions extends GenerationCreateOptions {
  pollInterval?: number;
  timeout?: number;
  timeoutInSeconds?: number;
  onProgress?: (progress: GenerationProgressResponse) => void | Promise<void>;
  showProgress?: boolean;
  progressRequestOptions?: DiffioClient.RequestOptions;
}

export class GenerationsClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async create(options: GenerationCreateOptions): Promise<CreateGenerationResponse> {
    return this._parent.createGeneration(options);
  }

  async getProgress(options: GenerationProgressOptions): Promise<GenerationProgressResponse> {
    return this._parent.getGenerationProgress(options);
  }

  async getDownload(options: GenerationDownloadOptions): Promise<GenerationDownloadResponse> {
    return this._parent.getGenerationDownload(options);
  }

  async getPlayback(options: GenerationPlaybackOptions): Promise<GenerationPlaybackResponse> {
    return this._parent.getGenerationPlayback(options);
  }

  async updateMix(options: GenerationMixOptions): Promise<GenerationMixResponse> {
    return this._parent.updateGenerationMix(options);
  }

  async waitForComplete(options: GenerationWaitOptions): Promise<GenerationProgressResponse> {
    return this._parent.waitForGeneration(options);
  }

  async createAndWait(
    options: GenerationCreateAndWaitOptions
  ): Promise<[CreateGenerationResponse, GenerationProgressResponse]> {
    const { progressRequestOptions, ...createOptions } = options;
    const generation = await this.create(createOptions);
    const progress = await this.waitForComplete({
      generationId: generation.generationId,
      apiProjectId: generation.apiProjectId,
      pollInterval: options.pollInterval,
      timeout: options.timeout,
      timeoutInSeconds: options.timeoutInSeconds,
      onProgress: options.onProgress,
      showProgress: options.showProgress,
      requestOptions: progressRequestOptions ?? options.requestOptions
    });
    return [generation, progress];
  }
}
