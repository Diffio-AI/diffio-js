import { Webhook } from "svix";
import { DiffioClient } from "../../../src/Client";
import type { GenerationWarning } from "../../../src/api/types";

const secret = `whsec_${Buffer.from("synthetic-webhook-signing-key").toString("base64")}`;

const unsupportedLanguage: GenerationWarning = {
  code: "unsupported_language",
  languages: ["ja"],
  message: "This recording contains speech in a language Diffio doesn't support yet (ja). The result probably won't be usable."
};

function verify(extra: Record<string, unknown>) {
  const client = new DiffioClient({ apiKey: "test" });
  const timestamp = new Date();
  const eventId = "msg_warnings";
  const payload = JSON.stringify({
    eventType: "generation.processing",
    eventId: "evt_warnings",
    createdAt: timestamp.toISOString(),
    apiKeyId: "key_synthetic",
    apiProjectId: "proj_warnings",
    generationId: "gen_warnings",
    status: "processing",
    hasVideo: false,
    modelKey: "diffio-4.7-flash",
    error: null,
    errorDetails: null,
    transcription: { status: "available" },
    ...extra
  });
  return client.webhooks.verifySignature({
    payload,
    secret,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(eventId, timestamp, payload)
    }
  });
}

describe("generation webhook warnings", () => {
  test("verified events expose the generation's warnings", () => {
    const event = verify({ warnings: [unsupportedLanguage] });

    expect(event.warnings).toEqual([unsupportedLanguage]);
  });

  test.each([undefined, [], null, [{ code: "future_warning", languages: [], message: "Something new." }]])(
    "events without known warnings (%p) have no warnings field",
    (warnings) => {
      const event = verify(warnings === undefined ? {} : { warnings });

      expect(event).not.toHaveProperty("warnings");
      expect(event.transcription).toEqual({ status: "available" });
    }
  );

  test("generation.failed events pass retryable through; other events omit it", () => {
    const failed = verify({ eventType: "generation.failed", status: "error", error: "Transcription failed.", retryable: true });
    expect(failed.retryable).toBe(true);
    expect(verify({ retryable: false }).retryable).toBe(false);
    expect(verify({})).not.toHaveProperty("retryable");
    expect(verify({ retryable: "yes" })).not.toHaveProperty("retryable");
  });
});
