import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { DiffioClient } from "../../src/Client";
import { createFakeEdgeUploadWorker } from "../mock-server/fakeEdgeUploadWorker";
import { mockServerPool } from "../mock-server/MockServerPool";

describe("Diffio 4.5 models", () => {
  test.each([
    ["diffio-4.5-flash", "/v1/diffio-4.5-flash-generation"],
    ["diffio-4.5-pro", "/v1/diffio-4.5-pro-generation"]
  ] as const)("%s creates a generation on its own endpoint", async (model, path) => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post(path)
      .headers({ Authorization: "Bearer test", "Content-Type": "application/json" })
      .jsonBody({ apiProjectId: "proj_123" })
      .respondWith()
      .statusCode(200)
      .jsonBody({ generationId: "gen_45", apiProjectId: "proj_123", modelKey: model, status: "queued" })
      .build();

    const response = await client.generations.create({ apiProjectId: "proj_123", model });
    expect(response).toEqual({ generationId: "gen_45", apiProjectId: "proj_123", modelKey: model, status: "queued" });
  });

  test("omitting the model uses Diffio 4.5 Flash", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/diffio-4.5-flash-generation")
      .headers({ Authorization: "Bearer test", "Content-Type": "application/json" })
      .jsonBody({ apiProjectId: "proj_123" })
      .respondWith()
      .statusCode(200)
      .jsonBody({ generationId: "gen_default", apiProjectId: "proj_123", modelKey: "diffio-4.5-flash", status: "queued" })
      .build();

    const response = await client.generations.create({ apiProjectId: "proj_123" });
    expect(response.modelKey).toBe("diffio-4.5-flash");
  });

  test.each(["diffio-2", "diffio-2-flash", "diffio-3.2", "diffio-3.5", "diffio-4.0-flash", "diffio-4.0-pro"])(
    "removed model %s is refused before any request with the supported models",
    async (model) => {
      const requests: string[] = [];
      const server = mockServerPool.createServer();
      server.useHandlers(http.all(`${server.baseUrl}/*`, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({}, { status: 500 });
      }));
      const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

      await expect(client.generations.create({ apiProjectId: "proj_123", model: model as never })).rejects.toThrow(
        `Unsupported model: ${model}. Use diffio-4.5-flash or diffio-4.5-pro.`
      );
      expect(requests).toEqual([]);
    }
  );

  test("a server-side model_retired answer keeps its code and supported models", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });
    const responseBody = {
      error: "diffio-4.5-pro has been retired. Use a newer model.",
      code: "model_retired",
      retiredModel: "diffio-4.5-pro",
      supportedModels: ["diffio-5-flash"]
    };
    server.mockEndpoint().post("/v1/diffio-4.5-pro-generation").respondWith().statusCode(410)
      .header("Content-Type", "application/json").jsonBody(responseBody).build();

    await expect(client.generations.create({ apiProjectId: "proj_123", model: "diffio-4.5-pro" })).rejects.toMatchObject({
      statusCode: 410,
      message: responseBody.error,
      responseBody
    });
  });
});

describe("restore on the Mac fleet contract", () => {
  test("restore uploads through the edge, runs Diffio 4.5 Flash, and downloads the edge media URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffio-sdk-restore-"));
    const filePath = join(dir, "interview.wav");
    const original = Buffer.from("original interview audio", "utf8");
    const restored = Buffer.from("restored interview audio", "utf8");
    writeFileSync(filePath, original);

    const api = mockServerPool.createServer();
    const edge = mockServerPool.createServer();
    const objectKey = "api/users/user_1/projects/proj_45/original/interview.wav";
    const fakeEdge = createFakeEdgeUploadWorker({
      edgeBaseUrl: edge.baseUrl,
      uploadToken: "upload-token",
      objectKey,
      maxBytes: 2147483648,
      partSizeBytes: 33554432
    });
    edge.useHandlers(
      ...fakeEdge.handlers,
      http.get(`${edge.baseUrl}/m/media-token/generations/gen_45/clean.mp3`, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(new URL(request.url).searchParams.get("download")).toBe("interview_restored.mp3");
        return new HttpResponse(restored, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      })
    );
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200).jsonBody({
        apiProjectId: "proj_45",
        upload: {
          uploadSessionId: "api-proj_45",
          edgeBaseUrl: edge.baseUrl,
          uploadToken: "upload-token",
          objectKey,
          partSizeBytes: 33554432,
          maxBytes: 2147483648,
          expiresAt: "2026-10-08T12:00:00Z"
        },
        objectPath: objectKey,
        expiresAt: "2026-10-08T12:00:00Z"
      }).build();
      api.mockEndpoint().post("/v1/complete_project_upload").jsonBody({ apiProjectId: "proj_45" })
        .respondWith().statusCode(200)
        .jsonBody({ apiProjectId: "proj_45", status: "uploaded", sizeBytes: original.byteLength }).build();
      api.mockEndpoint().post("/v1/diffio-4.5-flash-generation").jsonBody({ apiProjectId: "proj_45" })
        .respondWith().statusCode(200)
        .jsonBody({ generationId: "gen_45", apiProjectId: "proj_45", modelKey: "diffio-4.5-flash", status: "queued" })
        .build();
      // MSW matches the most recently added handler first, so the later poll is registered first.
      api.mockEndpoint().post("/v1/get_generation_progress").respondWith().statusCode(200).jsonBody({
        generationId: "gen_45",
        apiProjectId: "proj_45",
        status: "complete",
        hasVideo: false,
        preProcessing: { jobId: null, status: "complete", progress: 100 },
        inference: { jobId: "job_1", status: "complete", progress: 100 },
        stage: "complete"
      }).build();
      api.mockEndpoint().post("/v1/get_generation_progress").respondWith().statusCode(200).jsonBody({
        generationId: "gen_45",
        apiProjectId: "proj_45",
        status: "processing",
        hasVideo: false,
        preProcessing: { jobId: null, status: "complete", progress: 100 },
        inference: { jobId: "job_1", status: "pending", progress: 0, statusMessage: "Queued" },
        stage: "queued",
        queue: {
          position: 2,
          connectedWorkers: 3,
          idleWorkers: 0,
          busyWorkers: 3,
          waitReason: "all_busy",
          message: "Waiting for compute: all processors are busy (2 ahead)"
        }
      }).build();
      api.mockEndpoint().post("/v1/get_generation_download")
        .jsonBody({ generationId: "gen_45", apiProjectId: "proj_45", downloadType: "audio" })
        .respondWith().statusCode(200).jsonBody({
          generationId: "gen_45",
          apiProjectId: "proj_45",
          downloadType: "audio",
          downloadUrl: `${edge.baseUrl}/m/media-token/generations/gen_45/clean.mp3?download=interview_restored.mp3`,
          fileName: "interview_restored.mp3",
          storagePath: "api/users/user_1/projects/proj_45/generations/gen_45/clean.mp3",
          mimeType: "audio/mpeg"
        }).build();

      const stages: Array<string | null | undefined> = [];
      const [content, metadata] = await client.restore({
        filePath,
        pollInterval: 0,
        onProgress: (progress) => {
          stages.push(progress.stage);
        }
      });

      expect(metadata.error).toBeNull();
      expect(metadata.ok).toBe(true);
      expect(Buffer.from(content ?? [])).toEqual(restored);
      expect(Buffer.from(fakeEdge.completedObjectBytes() ?? [])).toEqual(original);
      expect(metadata.generation?.modelKey).toBe("diffio-4.5-flash");
      expect(stages).toEqual(["queued", "complete"]);
      expect(metadata.download).toEqual({
        generationId: "gen_45",
        apiProjectId: "proj_45",
        downloadType: "audio",
        downloadUrl: `${edge.baseUrl}/m/media-token/generations/gen_45/clean.mp3?download=interview_restored.mp3`,
        fileName: "interview_restored.mp3",
        storagePath: "api/users/user_1/projects/proj_45/generations/gen_45/clean.mp3",
        mimeType: "audio/mpeg"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
