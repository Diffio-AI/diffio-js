import { createHmac, randomBytes } from "node:crypto";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  verifyWebhookSignatureAsync
} from "../../../src/core/webhookSignature";
import { DiffioWebhookVerificationError } from "../../../src/errors";
import { DiffioClient } from "../../../src/Client";

const rawSecret = randomBytes(24);
const SECRET = `whsec_${rawSecret.toString("base64")}`;
const NOW = 1_763_000_000;
const PAYLOAD = JSON.stringify({
  type: "generation.completed",
  id: "evt_0123456789abcdef0123456789abcdef",
  created_at: "2026-11-13T00:33:41Z",
  data: { object: "generation", id: "g1", project_id: "p1", end_user: null, status: "complete", kind: "restore" }
});

function headersFor(payload: string, timestamp = NOW, id = "msg_1") {
  // Computed independently of the SDK, as the Svix scheme documents it.
  const signature = createHmac("sha256", rawSecret).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` };
}

describe("verifyWebhookSignature", () => {
  test("accepts a valid delivery and returns the parsed event", () => {
    const event = verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD), SECRET, { now: NOW });
    expect(event.type).toBe("generation.completed");
    expect(event.data.project_id).toBe("p1");
  });

  test("the client method and the async WebCrypto variant agree", async () => {
    const client = new DiffioClient({ apiKey: "unused" });
    expect(client.webhooks.verifySignature(PAYLOAD, headersFor(PAYLOAD), SECRET, { now: NOW }).id).toMatch(/^evt_/);
    const event = await client.webhooks.verifySignatureAsync(new TextEncoder().encode(PAYLOAD), headersFor(PAYLOAD), SECRET, { now: NOW });
    expect(event.id).toMatch(/^evt_/);
    await expect(verifyWebhookSignatureAsync(`${PAYLOAD} `, headersFor(PAYLOAD), SECRET, { now: NOW }))
      .rejects.toBeInstanceOf(DiffioWebhookVerificationError);
  });

  test("accepts Headers objects, mixed-case names and several signatures", () => {
    const good = headersFor(PAYLOAD);
    const headers = new Headers({
      "Svix-Id": good["svix-id"],
      "Svix-Timestamp": good["svix-timestamp"],
      "Svix-Signature": `v1,bm90IGl0 ${good["svix-signature"]}`
    });
    expect(verifyWebhookSignature(Buffer.from(PAYLOAD), headers, SECRET, { now: NOW }).type).toBe("generation.completed");
  });

  test("rejects a changed body, a wrong secret and a missing header", () => {
    expect(() => verifyWebhookSignature(PAYLOAD.replace("p1", "p2"), headersFor(PAYLOAD), SECRET, { now: NOW }))
      .toThrow("Webhook signature does not match.");
    const otherSecret = `whsec_${randomBytes(24).toString("base64")}`;
    expect(() => verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD), otherSecret, { now: NOW })).toThrow(DiffioWebhookVerificationError);
    const { "svix-signature": _omit, ...partial } = headersFor(PAYLOAD);
    expect(() => verifyWebhookSignature(PAYLOAD, partial, SECRET, { now: NOW })).toThrow("Missing webhook headers: svix-signature");
    expect(() => verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD), "", { now: NOW })).toThrow(/secret is required/);
  });

  test("rejects old and future timestamps outside the tolerance", () => {
    expect(() => verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD, NOW - 301), SECRET, { now: NOW })).toThrow("too old");
    expect(() => verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD, NOW + 301), SECRET, { now: NOW })).toThrow("future");
    expect(verifyWebhookSignature(PAYLOAD, headersFor(PAYLOAD, NOW - 600), SECRET, { now: NOW, toleranceSeconds: 900 }).id)
      .toMatch(/^evt_/);
  });

  test("signWebhookPayload produces what verify accepts", () => {
    const signature = signWebhookPayload(PAYLOAD, SECRET, "msg_9", NOW);
    expect(signature).toBe(headersFor(PAYLOAD, NOW, "msg_9")["svix-signature"]);
    const headers = { "svix-id": "msg_9", "svix-timestamp": String(NOW), "svix-signature": signature };
    expect(verifyWebhookSignature(PAYLOAD, headers, SECRET, { now: NOW }).type).toBe("generation.completed");
  });
});
