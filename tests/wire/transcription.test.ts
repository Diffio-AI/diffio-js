import { DiffioClient } from "../../src/Client";
import { DiffioApiError } from "../../src/errors";
import { mockServerPool } from "../mock-server/MockServerPool";

describe("transcription wire contract", () => {
  test.each(["pending", "available", "unavailable"])(
    "generation progress exposes transcription %s independently of media",
    async (status) => {
      const server = mockServerPool.createServer();
      const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl });
      server.mockEndpoint()
        .post("/v1/get_generation_progress")
        .jsonBody({ apiProjectId: "proj_123", generationId: "gen_123" })
        .respondWith()
        .statusCode(200)
        .jsonBody({
          apiProjectId: "proj_123",
          generationId: "gen_123",
          status: "processing",
          hasVideo: true,
          inference: { status: "complete", progress: 100 },
          restoredVideo: { status: "running", progress: 50 },
          transcription: { status }
        })
        .build();

      const progress = await client.generations.getProgress({ apiProjectId: "proj_123", generationId: "gen_123" });

      expect(progress.status).toBe("processing");
      expect(progress.restoredVideo?.status).toBe("running");
      expect(progress.transcription).toEqual({ status });
    }
  );

  test.each([null, {}, { status: "unexpected" }, "available"])(
    "does not infer availability from unrecognized transcription metadata %p",
    async (transcription) => {
      const server = mockServerPool.createServer();
      const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl });
      server.mockEndpoint()
        .post("/v1/get_generation_progress")
        .respondWith()
        .statusCode(200)
        .jsonBody({ generationId: "gen_123", apiProjectId: "proj_123", status: "complete", transcription })
        .build();

      const progress = await client.getGenerationProgress({ generationId: "gen_123" });

      expect(progress.status).toBe("complete");
      expect(progress).not.toHaveProperty("transcription");
    }
  );

  test.each([
    { statusCode: 409, status: "pending", code: "TRANSCRIPT_PENDING", error: "Transcript is not ready yet." },
    { statusCode: 404, status: "unavailable", code: "TRANSCRIPT_UNAVAILABLE", error: "Transcript is unavailable." }
  ])("transcript download preserves $status errors", async ({ statusCode, status, code, error }) => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 3 });
    const responseBody = { error, code, transcription: { status } };
    server.mockEndpoint()
      .post("/v1/get_generation_download")
      .jsonBody({ apiProjectId: "proj_123", generationId: "gen_123", downloadType: "transcript" })
      .respondWith()
      .statusCode(statusCode)
      .header("Content-Type", "application/json")
      .jsonBody(responseBody)
      .build();

    const result = client.generations.getDownload({
      apiProjectId: "proj_123",
      generationId: "gen_123",
      downloadType: "transcript"
    });

    await expect(result).rejects.toBeInstanceOf(DiffioApiError);
    await expect(result).rejects.toMatchObject({ message: error, statusCode, responseBody });
  });
});
