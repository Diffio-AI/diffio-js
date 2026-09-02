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

  test("createGeneration rejects the retired diffio-3 model", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    await expect(
      client.createGeneration({ apiProjectId: "proj", model: "diffio-3" as never })
    ).rejects.toThrow("Unsupported model: diffio-3");
  });

  test("createAndWait forwards idempotencyKey to generation creation", async () => {
    const client = new DiffioClient({ apiKey: "test", baseUrl: "http://example.com" });
    const generation = {
      generationId: "gen_1",
      apiProjectId: "proj_1",
      modelKey: "diffio-3.5",
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
      model: "diffio-3.5",
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
      uploadUrl: "http://upload.example.com/file",
      uploadMethod: "PUT",
      objectPath: "uploads/sample.wav",
      bucket: "diffio",
      expiresAt: "2026-01-01T00:00:00Z"
    });
    const generationSpy = jest.spyOn(client, "createGeneration").mockResolvedValue({
      generationId: "gen_1",
      apiProjectId: "proj_1",
      modelKey: "diffio-3.5",
      status: "queued"
    });

    await client.audioIsolation.isolate({
      filePath: "sample.wav",
      model: "diffio-3.5",
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
