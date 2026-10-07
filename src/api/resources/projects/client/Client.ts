import type { DiffioClient } from "../../../../Client";
import type {
  CompleteProjectUploadResponse,
  ListProjectGenerationsResponse,
  ListProjectsResponse
} from "../../../types";

export interface ProjectsListOptions {
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ProjectsListGenerationsOptions {
  apiProjectId: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ProjectsCompleteUploadOptions {
  apiProjectId: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export class ProjectsClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async list(options: ProjectsListOptions = {}): Promise<ListProjectsResponse> {
    return this._parent.listProjects(options);
  }

  /** Confirms a finished edge upload and starts preprocessing; createProject already does this. */
  async completeUpload(options: ProjectsCompleteUploadOptions): Promise<CompleteProjectUploadResponse> {
    return this._parent.completeProjectUpload(options);
  }

  async listGenerations(options: ProjectsListGenerationsOptions): Promise<ListProjectGenerationsResponse> {
    return this._parent.listProjectGenerations(options);
  }
}
