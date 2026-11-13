import type { RequestOptions, Transport } from "../../core/transport";
import { Page, PagePromise, type ListResponse } from "../../core/pagination";
import { queryString, segment } from "../../core/url";
import { uploadToMediaHost } from "../../core/edgeUpload";
import { resolveFileInput, type FileInput } from "../../core/files";
import { DiffioError, DiffioUploadError } from "../../errors";
import type {
  ListParams,
  Project,
  ProjectCreateParams,
  ProjectDeleted,
  ProjectWithUpload
} from "../types";

/** `upload.complete` probes the file inside the request; the API allows it 180 s. */
const COMPLETE_UPLOAD_TIMEOUT_SECONDS = 180;
const COMPLETE_UPLOAD_MAX_RETRIES = 3;

export interface ProjectUploadOptions extends RequestOptions {
  /**
   * Call `POST .../upload/complete` after the bytes land so the project is checked and prepared now
   * (default true). With false the project becomes ready by itself about 30 s later.
   */
  complete?: boolean;
  /** Parts in flight at once (default 3). */
  partConcurrency?: number;
  /** Seconds before one media host request gives up (default 300). */
  partTimeout?: number;
  /** Called after each part lands. */
  onUploadProgress?: (progress: { bytes_sent: number; bytes_total: number; parts_done: number; parts_total: number }) => void;
}

export class ProjectsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /v2/projects`: creates a project and returns it with `upload` instructions. Send the bytes with
   * `projects.upload(project, file)`. `generation: { model }` requests the first restore now.
   */
  async create(params: ProjectCreateParams, options?: RequestOptions): Promise<ProjectWithUpload> {
    if (!params || typeof params.file_name !== "string" || !params.file_name.trim()) {
      throw new TypeError("file_name is required");
    }
    const { end_user: endUser, ...body } = params;
    return this.transport.request<ProjectWithUpload>({
      method: "POST",
      path: "/projects",
      body,
      idempotent: false,
      acceptsIdempotencyKey: true,
      options: endUser !== undefined && options?.endUser === undefined ? { ...options, endUser } : options
    });
  }

  /** `GET /v2/projects`: newest first. Await for one page, or `for await` to walk every project. */
  list(params: ListParams = {}, options?: RequestOptions): PagePromise<Project> {
    return PagePromise.from(async () => {
      const response = await this.transport.request<ListResponse<Project>>({
        method: "GET",
        path: `/projects${queryString({ limit: params.limit, cursor: params.cursor })}`,
        idempotent: true,
        options
      });
      return new Page(response, async (cursor) => this.list({ ...params, cursor }, options));
    });
  }

  /** `GET /v2/projects/{project_id}`. */
  async get(projectId: string, options?: RequestOptions): Promise<Project> {
    return this.transport.request<Project>({
      method: "GET",
      path: `/projects/${segment(projectId, "projectId")}`,
      idempotent: true,
      options
    });
  }

  /** `DELETE /v2/projects/{project_id}`: deletes the upload, every result, exports, drafts and the share. */
  async delete(projectId: string, options?: RequestOptions): Promise<ProjectDeleted> {
    return this.transport.request<ProjectDeleted>({
      method: "DELETE",
      path: `/projects/${segment(projectId, "projectId")}`,
      idempotent: true,
      options
    });
  }

  /** `POST /v2/projects/{project_id}/upload`: fresh upload instructions while the project awaits its file. */
  async reopenUpload(projectId: string, options?: RequestOptions): Promise<ProjectWithUpload> {
    return this.transport.request<ProjectWithUpload>({
      method: "POST",
      path: `/projects/${segment(projectId, "projectId")}/upload`,
      idempotent: true,
      options
    });
  }

  /**
   * `POST /v2/projects/{project_id}/upload/complete`: say the upload finished so the file is checked and
   * prepared now. Safe to repeat; `projects.upload` calls it for you.
   */
  async completeUpload(projectId: string, options?: RequestOptions): Promise<Project> {
    return this.transport.request<Project>({
      method: "POST",
      path: `/projects/${segment(projectId, "projectId")}/upload/complete`,
      idempotent: true,
      defaultTimeout: COMPLETE_UPLOAD_TIMEOUT_SECONDS,
      options: { ...options, maxRetries: options?.maxRetries ?? Math.max(COMPLETE_UPLOAD_MAX_RETRIES, this.transport.retryPolicy().maxRetries) }
    });
  }

  /**
   * Sends the media bytes to Diffio's media host by following `project.upload.requests` (start, parts of
   * `part_size_bytes`, complete; parts retried), then calls `completeUpload` unless `complete: false`.
   * `project` is the object `create` returned, or a project id (new instructions are fetched with
   * `reopenUpload`). `file` is a path (Node), a Blob or File, or bytes. Returns the project after upload.
   */
  async upload(project: ProjectWithUpload | string, file: FileInput, options: ProjectUploadOptions = {}): Promise<Project> {
    let target: ProjectWithUpload;
    if (typeof project === "string") target = await this.reopenUpload(project, options);
    else target = project;
    if (!target || !target.id) throw new TypeError("project is required");
    if (!target.upload) {
      throw new DiffioError(
        `Project ${target.id} has no upload instructions (status ${target.status}); its file may already have arrived.`
      );
    }

    const resolved = await resolveFileInput(file);
    try {
      await uploadToMediaHost({
        upload: target.upload,
        source: resolved.source,
        fetch: this.transport.fetchFn,
        partConcurrency: options.partConcurrency,
        timeout: options.partTimeout,
        signal: options.signal,
        onProgress: options.onUploadProgress
      });
    } catch (error) {
      if (error instanceof DiffioUploadError) error.project_id = error.project_id ?? target.id;
      throw error;
    } finally {
      await resolved.source.close?.();
    }

    if (options.complete === false) return this.get(target.id, options);
    return this.completeUpload(target.id, options);
  }
}
