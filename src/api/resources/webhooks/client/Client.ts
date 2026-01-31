import type { DiffioClient } from "../../../../Client";
import { DiffioApiError } from "../../../../errors";
import { parseGenerationWebhookEvent } from "../../../serialization";
import type { GenerationWebhookEvent, WebhookTestEventResponse } from "../../../types";
import { Webhook } from "svix";

export interface WebhookTestEventOptions {
  eventType: string;
  mode: string;
  apiKeyId?: string;
  samplePayload?: Record<string, unknown>;
  requestOptions?: DiffioClient.RequestOptions;
}

export type WebhookHeaders = Record<string, string | string[] | undefined> | Headers;

export interface WebhookVerifyOptions {
  payload: string | Uint8Array;
  headers: WebhookHeaders;
  secret: string;
}

export class WebhooksClient {
  private _parent: DiffioClient;

  constructor(parent: DiffioClient) {
    this._parent = parent;
  }

  async sendTestEvent(options: WebhookTestEventOptions): Promise<WebhookTestEventResponse> {
    return this._parent.sendWebhookTestEvent(options);
  }

  verifySignature(options: WebhookVerifyOptions): GenerationWebhookEvent {
    const { payload, headers, secret } = options;
    if (!secret) {
      throw new DiffioApiError("secret is required");
    }

    const normalizedHeaders = normalizeSvixHeaders(headers);
    const body = normalizePayload(payload);
    const webhook = new Webhook(secret);

    try {
      const event = webhook.verify(body, normalizedHeaders) as Record<string, unknown>;
      if (!event || typeof event !== "object") {
        throw new DiffioApiError("Webhook payload must be an object");
      }
      return parseGenerationWebhookEvent(event);
    } catch (error) {
      if (error instanceof DiffioApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Webhook signature verification failed";
      throw new DiffioApiError(message);
    }
  }
}

function normalizePayload(payload: string | Uint8Array): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(payload).toString("utf8");
  }
  return new TextDecoder().decode(payload);
}

function normalizeSvixHeaders(headers: WebhookHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      normalized[key.toLowerCase()] = value;
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) {
        continue;
      }
      normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }

  const required = ["svix-id", "svix-timestamp", "svix-signature"];
  const missing = required.filter((header) => !normalized[header]);
  if (missing.length > 0) {
    throw new DiffioApiError(`Missing webhook headers: ${missing.join(", ")}`);
  }

  return {
    "svix-id": normalized["svix-id"],
    "svix-timestamp": normalized["svix-timestamp"],
    "svix-signature": normalized["svix-signature"]
  };
}
