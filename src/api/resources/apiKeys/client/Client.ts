import type { DiffioClient } from "../../../../Client";
import type { ApiKeyResponse, ApiKeysListResponse } from "../../../types";

export interface ApiKeysCreateOptions {
  label: string;
  scopes: string[];
  resourceBounds?: Record<string, unknown>;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ApiKeysListOptions {
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ApiKeysRotateOptions {
  keyId: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface ApiKeysRevokeOptions {
  keyId: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export class ApiKeysClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async create(options: ApiKeysCreateOptions): Promise<ApiKeyResponse> {
    return this._parent.createApiKey(options);
  }

  async list(options: ApiKeysListOptions = {}): Promise<ApiKeysListResponse> {
    return this._parent.listApiKeys(options);
  }

  async rotate(options: ApiKeysRotateOptions): Promise<ApiKeyResponse> {
    return this._parent.rotateApiKey(options);
  }

  async revoke(options: ApiKeysRevokeOptions): Promise<ApiKeyResponse> {
    return this._parent.revokeApiKey(options);
  }
}
