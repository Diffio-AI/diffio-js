import type { DiffioClient } from "../../../../Client";
import type { ListProjectGenerationsResponse, ListProjectsResponse } from "../../../types";

export interface ProjectsListOptions {
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ProjectsListGenerationsOptions {
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

  async listGenerations(options: ProjectsListGenerationsOptions): Promise<ListProjectGenerationsResponse> {
    return this._parent.listProjectGenerations(options);
  }
}
