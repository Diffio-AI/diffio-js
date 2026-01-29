import type { DiffioClient } from "../../../../Client";
import type { WebhookPortalResponse, WebhookTestEventResponse } from "../../../types";

export interface WebhookPortalAccessOptions {
  mode: string;
  apiKeyId?: string;
  requestOptions?: DiffioClient.RequestOptions;
}

export interface WebhookTestEventOptions {
  eventType: string;
  mode: string;
  apiKeyId?: string;
  samplePayload?: Record<string, unknown>;
  requestOptions?: DiffioClient.RequestOptions;
}

export class WebhooksClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async getPortalAccess(options: WebhookPortalAccessOptions): Promise<WebhookPortalResponse> {
    return this._parent.getWebhooksPortalAccess(options);
  }

  async sendTestEvent(options: WebhookTestEventOptions): Promise<WebhookTestEventResponse> {
    return this._parent.sendWebhookTestEvent(options);
  }
}
