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
      client.createGeneration({ apiProjectId: "proj", model: "unknown-model" })
    ).rejects.toThrow(DiffioApiError);
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
