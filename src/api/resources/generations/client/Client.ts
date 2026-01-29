import type { DiffioClient } from "../../../../Client";
import type {
  CreateGenerationResponse,
  GenerationDownloadResponse,
  GenerationProgressResponse
} from "../../../types";

export interface GenerationCreateOptions {
  apiProjectId: string;
  model?: string;
  sampling?: Record<string, unknown>;
  params?: Record<string, unknown>;
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
  requestOptions?: DiffioClient.RequestOptions;
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
