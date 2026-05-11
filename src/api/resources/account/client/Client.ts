import type { DiffioClient } from "../../../../Client";
import type { AccountSettingsResponse } from "../../../types";

export interface AccountGetSettingsOptions {
  requestOptions?: DiffioClient.RequestOptions;
}

export interface AccountUpdateSettingsOptions {
  billingPolicy: Record<string, unknown>;
  requestOptions?: DiffioClient.RequestOptions;
}

export class AccountClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async getSettings(options: AccountGetSettingsOptions = {}): Promise<AccountSettingsResponse> {
    return this._parent.getAccountSettings(options);
  }

  async updateSettings(options: AccountUpdateSettingsOptions): Promise<AccountSettingsResponse> {
    return this._parent.updateAccountSettings(options);
  }
}
