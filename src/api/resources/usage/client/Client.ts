import type { DiffioClient } from "../../../../Client";
import type { UsageSummaryResponse } from "../../../types";

export interface UsageSummaryOptions {
  apiKeyId?: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export class UsageClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async summary(options: UsageSummaryOptions = {}): Promise<UsageSummaryResponse> {
    return this._parent.getUsageSummary(options);
  }
}
