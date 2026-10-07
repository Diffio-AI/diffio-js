import { DiffioClient } from "../../../src/Client";
import { DiffioApiError } from "../../../src/errors";

describe("DiffioClient", () => {
  const originalApiKey = process.env.DIFFIO_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.DIFFIO_API_KEY;
    } else {
      process.env.DIFFIO_API_KEY = originalApiKey;
    }
  });

  test("requires apiKey when not provided", () => {
    delete process.env.DIFFIO_API_KEY;
    expect(() => new DiffioClient()).toThrow(DiffioApiError);
  });

  test("createProject requires filePath", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.createProject({ filePath: "" } as any)
    ).rejects.toThrow(DiffioApiError);
  });

  test("createGeneration rejects unsupported model", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.createGeneration({ apiProjectId: "proj", model: "unknown-model" as never })
    ).rejects.toThrow(DiffioApiError);
  });

  test.each(["diffio-2", "diffio-2-flash", "diffio-3.2", "diffio-4.0-flash"])(
    "createGeneration refuses the removed %s model and names the supported ones",
    async (model) => {
      const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
      await expect(
        client.createGeneration({ apiProjectId: "proj", model: model as never })
      ).rejects.toThrow(`Unsupported model: ${model}. Use diffio-4.5-flash or diffio-4.5-pro.`);
    }
  );

  test("createAndWait forwards idempotencyKey to generation creation", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    const generation = {
      generationId: "gen_1",
      apiProjectId: "proj_1",
      modelKey: "diffio-4.5-pro",
      status: "queued",
      idempotentReplay: true
    };
    const progress = {
      generationId: "gen_1",
      apiProjectId: "proj_1",
      status: "complete",
      hasVideo: false,
      preProcessing: { status: "complete", progress: 100 },
      inference: { status: "complete", progress: 100 }
    };
    const createSpy = jest.spyOn(client, "createGeneration").mockResolvedValue(generation);
    jest.spyOn(client, "waitForGeneration").mockResolvedValue(progress);

    const result = await client.generations.createAndWait({
      apiProjectId: "proj_1",
      model: "diffio-4.5-pro",
      idempotencyKey: "restore-proj-1"
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "restore-proj-1" })
    );
    expect(result).toEqual([generation, progress]);
  });

  test("audio isolation forwards idempotencyKey to generation creation", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    jest.spyOn(client, "createProject").mockResolvedValue({
      apiProjectId: "proj_1",
      upload: {
        uploadSessionId: "api-proj_1",
        edgeBaseUrl: "https://media.example.com",
        objectKey: "api/users/user_1/projects/proj_1/original/sample.wav",
        partSizeBytes: 33554432,
        maxBytes: 2147483648,
        expiresAt: "2026-01-01T00:00:00Z"
      },
      objectPath: "api/users/user_1/projects/proj_1/original/sample.wav",
      expiresAt: "2026-01-01T00:00:00Z",
      uploadCompletion: { apiProjectId: "proj_1", status: "uploaded", sizeBytes: 1024 }
    });
    const generationSpy = jest.spyOn(client, "createGeneration").mockResolvedValue({
      generationId: "gen_1",
      apiProjectId: "proj_1",
      modelKey: "diffio-4.5-pro",
      status: "queued"
    });

    await client.audioIsolation.isolate({
      filePath: "sample.wav",
      model: "diffio-4.5-pro",
      idempotencyKey: "restore-proj-1"
    });

    expect(generationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "restore-proj-1" })
    );
  });

  test("restore helper forwards idempotencyKey to audio isolation", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    const isolateSpy = jest
      .spyOn(client, "audioIsolationIsolate")
      .mockRejectedValue(new Error("stop after option forwarding"));

    const [, metadata] = await client.audioIsolation.restoreAudio({
      filePath: "sample.wav",
      idempotencyKey: "restore-proj-1"
    });

    expect(isolateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "restore-proj-1" })
    );
    expect(metadata.stage).toBe("isolate");
  });

  test("getGenerationDownload rejects invalid downloadType", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.getGenerationDownload({ apiProjectId: "proj", generationId: "gen", downloadType: "text" })
    ).rejects.toThrow(DiffioApiError);
  });

  test("sendWebhookTestEvent rejects invalid eventType", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.sendWebhookTestEvent({ eventType: "generation.unknown", mode: "live" })
    ).rejects.toThrow(DiffioApiError);
  });

  test("sendWebhookTestEvent rejects invalid samplePayload", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.sendWebhookTestEvent({
        eventType: "generation.completed",
        mode: "live",
        samplePayload: "invalid" as any
      })
    ).rejects.toThrow(DiffioApiError);
  });
});
