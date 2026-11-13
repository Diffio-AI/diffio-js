// Verifies Diffio webhook deliveries. Diffio delivers webhooks through Svix, so a delivery carries
// `svix-id`, `svix-timestamp` and `svix-signature` headers, and the endpoint's signing secret starts
// `whsec_`. The signature is base64(HMAC-SHA256(key = base64-decoded secret, "{id}.{timestamp}.{raw body}")),
// listed as space-separated `v1,<signature>` entries. Node uses node:crypto (sync); any runtime with
// WebCrypto (browsers, Deno, Cloudflare Workers, Bun, Node 18+) can use the async variant.

import { DiffioWebhookVerificationError } from "../errors";
import type { WebhookEvent } from "../api/types";
import { nodeRequire } from "./node";

export type WebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined | null>;

export interface VerifySignatureOptions {
  /** How far the timestamp may be from now, in seconds (default 300, as Svix). */
  toleranceSeconds?: number;
  /** "Now" in seconds since the epoch, for tests. */
  now?: number;
}

export type WebhookPayload = string | Uint8Array | ArrayBuffer;

const SIGNATURE_PREFIX = "v1,";

function headerValue(headers: WebhookHeaders, name: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string | string[] | undefined | null>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name || value == null) continue;
    return Array.isArray(value) ? value.join(" ") : String(value);
  }
  return null;
}

function payloadText(payload: WebhookPayload): string {
  if (typeof payload === "string") return payload;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return new TextDecoder().decode(bytes);
}

function decodeBase64(text: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function secretKey(secret: string): Uint8Array {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new DiffioWebhookVerificationError("The webhook signing secret is required (it starts whsec_).");
  }
  const trimmed = secret.trim();
  return decodeBase64(trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed);
}

interface Prepared {
  signedContent: string;
  signatures: string[];
  body: string;
}

function prepare(payload: WebhookPayload, headers: WebhookHeaders, options?: VerifySignatureOptions): Prepared {
  if (!headers) throw new DiffioWebhookVerificationError("Webhook headers are required.");
  const id = headerValue(headers, "svix-id") ?? headerValue(headers, "webhook-id");
  const timestamp = headerValue(headers, "svix-timestamp") ?? headerValue(headers, "webhook-timestamp");
  const signature = headerValue(headers, "svix-signature") ?? headerValue(headers, "webhook-signature");
  const missing = [
    id ? null : "svix-id",
    timestamp ? null : "svix-timestamp",
    signature ? null : "svix-signature"
  ].filter(Boolean);
  if (missing.length > 0) throw new DiffioWebhookVerificationError(`Missing webhook headers: ${missing.join(", ")}`);

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) throw new DiffioWebhookVerificationError("Invalid svix-timestamp header.");
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (now - seconds > tolerance) throw new DiffioWebhookVerificationError("Webhook timestamp is too old.");
  if (seconds - now > tolerance) throw new DiffioWebhookVerificationError("Webhook timestamp is in the future.");

  const signatures = String(signature)
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(SIGNATURE_PREFIX))
    .map((entry) => entry.slice(SIGNATURE_PREFIX.length));
  if (signatures.length === 0) throw new DiffioWebhookVerificationError("No v1 signature in svix-signature.");
  const body = payloadText(payload);
  return { signedContent: `${id}.${timestamp}.${body}`, signatures, body };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function finish(prepared: Prepared, expected: string): WebhookEvent {
  if (!prepared.signatures.some((signature) => constantTimeEqual(signature, expected))) {
    throw new DiffioWebhookVerificationError("Webhook signature does not match.");
  }
  let event: unknown;
  try {
    event = JSON.parse(prepared.body);
  } catch {
    throw new DiffioWebhookVerificationError("Webhook payload is not JSON.");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new DiffioWebhookVerificationError("Webhook payload must be a JSON object.");
  }
  return event as WebhookEvent;
}

/**
 * Checks a delivery's signature and timestamp with node:crypto and returns the parsed event.
 * Pass the raw request body exactly as received (not re-serialized JSON). Throws
 * DiffioWebhookVerificationError when anything does not check out. Node only; elsewhere use
 * `verifySignatureAsync`.
 */
export function verifyWebhookSignature(
  payload: WebhookPayload,
  headers: WebhookHeaders,
  secret: string,
  options?: VerifySignatureOptions
): WebhookEvent {
  const key = secretKey(secret);
  const prepared = prepare(payload, headers, options);
  const crypto = nodeRequire<typeof import("node:crypto")>("node:crypto");
  if (!crypto) {
    throw new DiffioWebhookVerificationError("verifySignature needs Node's crypto; use verifySignatureAsync here.");
  }
  const expected = crypto.createHmac("sha256", key).update(prepared.signedContent, "utf8").digest("base64");
  return finish(prepared, expected);
}

/** Same check with WebCrypto, for browsers, edge runtimes, Deno and Bun (works in Node 18+ too). */
export async function verifyWebhookSignatureAsync(
  payload: WebhookPayload,
  headers: WebhookHeaders,
  secret: string,
  options?: VerifySignatureOptions
): Promise<WebhookEvent> {
  const key = secretKey(secret);
  const prepared = prepare(payload, headers, options);
  let subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) subtle = nodeRequire<{ webcrypto: Crypto }>("node:crypto")?.webcrypto.subtle;
  if (!subtle) throw new DiffioWebhookVerificationError("WebCrypto is not available in this runtime.");
  const cryptoKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(prepared.signedContent));
  return finish(prepared, encodeBase64(new Uint8Array(signature)));
}

/** Signs a payload the way Svix does; for tests of your own webhook handler. */
export function signWebhookPayload(payload: string, secret: string, id: string, timestamp: number): string {
  const crypto = nodeRequire<typeof import("node:crypto")>("node:crypto");
  if (!crypto) throw new DiffioWebhookVerificationError("signWebhookPayload needs Node's crypto.");
  const digest = crypto.createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${payload}`, "utf8").digest("base64");
  return `${SIGNATURE_PREFIX}${digest}`;
}
