// Shares, usage and webhooks.

import type { RequestOptions, Transport } from "../../core/transport";
import { queryString, segment } from "../../core/url";
import {
  verifyWebhookSignature,
  verifyWebhookSignatureAsync,
  type VerifySignatureOptions,
  type WebhookHeaders,
  type WebhookPayload
} from "../../core/webhookSignature";
import type {
  ProjectShare,
  ProjectSharePublishParams,
  ProjectShareRevoked,
  Usage,
  UsageParams,
  WebhookEvent,
  WebhookPortal
} from "../types";

export class SharesResource {
  constructor(private readonly transport: Transport) {}

  /** `PUT /v2/projects/{project_id}/share`: publishes a public, key-free view of the project's result. */
  async publish(projectId: string, params: ProjectSharePublishParams = {}, options?: RequestOptions): Promise<ProjectShare> {
    return this.transport.request<ProjectShare>({
      method: "PUT",
      path: `/projects/${segment(projectId, "projectId")}/share`,
      body: params,
      idempotent: true,
      options
    });
  }

  /** `GET /v2/projects/{project_id}/share`: the published share (404 `share_not_found` when none). */
  async get(projectId: string, options?: RequestOptions): Promise<ProjectShare> {
    return this.transport.request<ProjectShare>({
      method: "GET",
      path: `/projects/${segment(projectId, "projectId")}/share`,
      idempotent: true,
      options
    });
  }

  /** `DELETE /v2/projects/{project_id}/share`: revokes the share; its URLs stop working. */
  async revoke(projectId: string, options?: RequestOptions): Promise<ProjectShareRevoked> {
    return this.transport.request<ProjectShareRevoked>({
      method: "DELETE",
      path: `/projects/${segment(projectId, "projectId")}/share`,
      idempotent: true,
      options
    });
  }

  /** `GET /v2/shares/{share_id}`: the public view anyone with the id can read. Needs no API key. */
  async getPublic(shareId: string, options?: RequestOptions): Promise<ProjectShare> {
    return this.transport.request<ProjectShare>({
      method: "GET",
      path: `/shares/${segment(shareId, "shareId")}`,
      idempotent: true,
      noAuth: true,
      options
    });
  }
}

export class UsageResource {
  constructor(private readonly transport: Transport) {}

  /** `GET /v2/usage`: generations, billable seconds and list price for a period (default this month). */
  async get(params: UsageParams = {}, options?: RequestOptions): Promise<Usage> {
    return this.transport.request<Usage>({
      method: "GET",
      path: `/usage${queryString({ start: params.start, end: params.end })}`,
      idempotent: true,
      options
    });
  }
}

export class WebhooksResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /v2/webhooks/portal`: a short-lived link to the webhook portal, where you add endpoints, pick
   * events and copy each endpoint's signing secret. Needs a key with write permission. The portal belongs
   * to the account, so this call never sends `Diffio-End-User`, even when the client sets `endUser`.
   */
  async portal(options?: RequestOptions): Promise<WebhookPortal> {
    return this.transport.request<WebhookPortal>({
      method: "POST",
      path: "/webhooks/portal",
      idempotent: true,
      accountLevel: true,
      options
    });
  }

  /**
   * Checks a delivery's `svix-id`, `svix-timestamp` and `svix-signature` against the endpoint's
   * `whsec_` secret (Node crypto) and returns the parsed event. Pass the raw body as received.
   */
  verifySignature(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret: string,
    options?: VerifySignatureOptions
  ): WebhookEvent {
    return verifyWebhookSignature(payload, headers, secret, options);
  }

  /** The same check with WebCrypto, for browsers, edge runtimes, Deno and Bun. */
  verifySignatureAsync(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret: string,
    options?: VerifySignatureOptions
  ): Promise<WebhookEvent> {
    return verifyWebhookSignatureAsync(payload, headers, secret, options);
  }
}
