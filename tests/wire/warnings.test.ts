import { DiffioClient } from "../../src/Client";
import type { GenerationWarning } from "../../src/api/types";
import { mockServerPool } from "../mock-server/MockServerPool";

const unsupportedLanguage: GenerationWarning = {
  code: "unsupported_language",
  languages: ["ja", "ko"],
  message: "This recording contains speech in a language Diffio doesn't support yet (ja, ko). The result probably won't be usable."
};

const progressBody = {
  generationId: "gen_123",
  apiProjectId: "proj_123",
  status: "processing",
  hasVideo: false,
  preProcessing: { status: "complete", progress: 100 },
  inference: { status: "running", progress: 40 },
  stage: "restoring",
  transcription: { status: "available" }
};

async function getProgress(body: Record<string, unknown>) {
  const server = mockServerPool.createServer();
  const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });
  server.mockEndpoint()
    .post("/v1/get_generation_progress")
    .jsonBody({ generationId: "gen_123", apiProjectId: "proj_123" })
    .respondWith()
    .statusCode(200)
    .jsonBody(body)
    .build();
  return client.generations.getProgress({ generationId: "gen_123", apiProjectId: "proj_123" });
}

describe("generation progress warnings", () => {
  test("exposes unsupported language warnings once the transcript is ready", async () => {
    const progress = await getProgress({ ...progressBody, warnings: [unsupportedLanguage] });

    expect(progress.warnings).toEqual([unsupportedLanguage]);
    expect(progress.status).toBe("processing");
  });

  test("is an empty array before the transcript is ready", async () => {
    const progress = await getProgress({ ...progressBody, transcription: { status: "pending" }, warnings: [] });

    expect(progress.warnings).toEqual([]);
  });

  test("is an empty array when an older API version omits it", async () => {
    const progress = await getProgress(progressBody);

    expect(progress.warnings).toEqual([]);
  });

  test.each([null, "unsupported_language", { code: "unsupported_language" }])(
    "treats a malformed warnings value %p as no warnings",
    async (warnings) => {
      const progress = await getProgress({ ...progressBody, warnings });

      expect(progress.warnings).toEqual([]);
    }
  );

  test("drops warnings with unknown codes or missing fields and keeps the rest", async () => {
    const progress = await getProgress({
      ...progressBody,
      warnings: [
        { code: "future_warning", languages: [], message: "Something new." },
        { code: "unsupported_language", message: "No languages." },
        { code: "unsupported_language", languages: ["ja"] },
        null,
        { ...unsupportedLanguage, languages: ["ja", 7, "", "ko"], extra: true }
      ]
    });

    expect(progress.warnings).toEqual([unsupportedLanguage]);
  });
});

describe("generation progress retryable", () => {
  const failedBody = {
    ...progressBody,
    status: "failed",
    stage: "failed",
    transcription: { status: "unavailable" },
    warnings: []
  };

  test.each([
    [true, "We couldn't transcribe this file. Please try again."],
    [false, "No speech detected."]
  ] as const)("reports retryable=%p with the error", async (retryable, error) => {
    const progress = await getProgress({ ...failedBody, error, errorDetails: null, retryable });

    expect(progress.error).toBe(error);
    expect(progress.retryable).toBe(retryable);
  });

  test("omits retryable when the response has no error", async () => {
    const progress = await getProgress({ ...progressBody, warnings: [] });

    expect(progress.error).toBeNull();
    expect(progress).not.toHaveProperty("retryable");
  });

  test("omits retryable when an older API version sends an error without it", async () => {
    const progress = await getProgress({ ...failedBody, error: "Restoration failed." });

    expect(progress.error).toBe("Restoration failed.");
    expect(progress).not.toHaveProperty("retryable");
  });

  test("ignores a non-boolean retryable", async () => {
    const progress = await getProgress({ ...failedBody, error: "Restoration failed.", retryable: "true" });

    expect(progress).not.toHaveProperty("retryable");
  });
});
