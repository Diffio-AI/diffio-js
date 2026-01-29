import type { DiffioClient } from "../../../../Client";
import type { AudioIsolationResult, RestoreMetadata } from "../../../types";

export interface AudioIsolationRestoreOptions {
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
  onProgress?: (progress: unknown) => void | Promise<void>;
  showProgress?: boolean;
  requestOptions?: DiffioClient.RequestOptions;
  progressRequestOptions?: DiffioClient.RequestOptions;
  downloadRequestOptions?: DiffioClient.RequestOptions;
  raiseOnError?: boolean;
}

export interface AudioIsolationIsolateOptions {
  filePath: string;
  contentType?: string;
  contentLength?: number;
  fileFormat?: string;
  model?: string;
  sampling?: Record<string, unknown>;
  projectParams?: Record<string, unknown>;
  generationParams?: Record<string, unknown>;
  requestOptions?: DiffioClient.RequestOptions;
}

export class AudioIsolationClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async convert(options: AudioIsolationIsolateOptions): Promise<AudioIsolationResult> {
    return this.isolate(options);
  }

  async isolate(options: AudioIsolationIsolateOptions): Promise<AudioIsolationResult> {
    const {
      filePath,
      contentType,
      contentLength,
      fileFormat,
      model,
      sampling,
      projectParams,
      generationParams,
      requestOptions
    } = options;

    return this._parent.audioIsolationIsolate({
      filePath,
      contentType,
      contentLength,
      fileFormat,
      model,
      sampling,
      projectParams,
      generationParams,
      requestOptions
    });
  }

  async restoreAudio(options: AudioIsolationRestoreOptions): Promise<[Uint8Array | null, RestoreMetadata]> {
    return this._parent.restoreAudio(options);
  }

  async restore(options: AudioIsolationRestoreOptions): Promise<[Uint8Array | null, RestoreMetadata]> {
    return this.restoreAudio(options);
  }
}
