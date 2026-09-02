import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffioClient } from "../../src/Client";
import { DIFFIO_SDK_VERSION } from "../../src/version";
import { mockServerPool } from "../mock-server/MockServerPool";

describe("DiffioClient wire", () => {
  test("createProject sends payload and returns response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffio-sdk-"));
    const filePath = join(dir, "demo.txt");
    const fileContents = "hello world";
    writeFileSync(filePath, fileContents);

    const server = mockServerPool.createServer();
    const uploadServer = mockServerPool.createServer({ baseUrl: "http://upload.local" });
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    try {
      server
        .mockEndpoint()
        .post("/v1/create_project")
        .headers({
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "X-Diffio-SDK-Language": "JavaScript",
          "X-Diffio-SDK-Name": "diffio",
          "X-Diffio-SDK-Version": DIFFIO_SDK_VERSION
        })
        .jsonBody({
          fileName: "demo.txt",
          contentType: "text/plain",
          contentLength: Buffer.byteLength(fileContents)
        })
        .respondWith()
        .statusCode(200)
        .jsonBody({
          apiProjectId: "proj_123",
          uploadUrl: "http://upload.local/file",
          uploadMethod: "PUT",
          objectPath: "uploads/demo.txt",
          bucket: "diffio",
          expiresAt: "2024-01-01T00:00:00Z"
        })
        .build();

      uploadServer
        .mockEndpoint()
        .put("/file")
        .headers({
          "Content-Type": "text/plain"
        })
        .respondWith()
        .statusCode(200)
        .jsonBody({})
        .build();

      const response = await client.createProject({ filePath });
      expect(response).toEqual({
        apiProjectId: "proj_123",
        uploadUrl: "http://upload.local/file",
        uploadMethod: "PUT",
        objectPath: "uploads/demo.txt",
        bucket: "diffio",
        expiresAt: "2024-01-01T00:00:00Z"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createGeneration routes to model endpoint", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/diffio-2.0-generation")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({ apiProjectId: "proj_123" })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        generationId: "gen_1",
        apiProjectId: "proj_123",
        modelKey: "diffio-2",
        status: "queued"
      })
      .build();

    const response = await client.createGeneration({ apiProjectId: "proj_123", model: "diffio-2" });
    expect(response).toEqual({
      generationId: "gen_1",
      apiProjectId: "proj_123",
      modelKey: "diffio-2",
      status: "queued"
    });
    expect("idempotentReplay" in response).toBe(false);
  });

  test("generation resource sends idempotency key and parses replay response", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/diffio-3.5-generation")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({
        apiProjectId: "proj_123",
        idempotencyKey: "restore-proj-123"
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        generationId: "gen_35",
        apiProjectId: "proj_123",
        modelKey: "diffio-3.5",
        status: "queued",
        idempotentReplay: true
      })
      .build();

    const response = await client.generations.create({
      apiProjectId: "proj_123",
      model: "diffio-3.5",
      idempotencyKey: "restore-proj-123"
    });
    expect(response).toEqual({
      generationId: "gen_35",
      apiProjectId: "proj_123",
      modelKey: "diffio-3.5",
      status: "queued",
      idempotentReplay: true
    });
  });

  test("getGenerationDownload accepts transcript download type", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/get_generation_download")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({
        generationId: "gen_1",
        apiProjectId: "proj_1",
        downloadType: "transcript"
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        generationId: "gen_1",
        apiProjectId: "proj_1",
        downloadType: "transcript",
        downloadUrl: "https://download.test/word_timestamps.json",
        fileName: "word_timestamps.json",
        storagePath: "users/u/projects/proj_1/generations/gen_1/word_timestamps.json",
        bucket: "diffio_api",
        mimeType: "application/json"
      })
      .build();

    const response = await client.generations.getDownload({
      generationId: "gen_1",
      apiProjectId: "proj_1",
      downloadType: "transcript"
    });
    expect(response.downloadType).toBe("transcript");
    expect(response.fileName).toBe("word_timestamps.json");
  });

  test("listProjects parses response", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/list_projects")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({})
      .respondWith()
      .statusCode(200)
      .jsonBody({
        projects: [
          {
            apiProjectId: "proj_1",
            status: "complete",
            originalFileName: "song.wav",
            contentType: "audio/wav",
            hasVideo: false,
            generationCount: "2",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-02T00:00:00Z"
          }
        ]
      })
      .build();

    const response = await client.listProjects();
    expect(response).toEqual({
      projects: [
        {
          apiProjectId: "proj_1",
          status: "complete",
          originalFileName: "song.wav",
          contentType: "audio/wav",
          hasVideo: false,
          generationCount: 2,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-02T00:00:00Z"
        }
      ]
    });
  });

  test("sendWebhookTestEvent sends payload and returns response", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/webhooks/send_test_event")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({
        eventType: "generation.completed",
        mode: "live",
        apiKeyId: "key_123",
        samplePayload: { apiProjectId: "proj_123" }
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        svixMessageId: "msg_123",
        eventId: "evt_123",
        eventType: "generation.completed",
        mode: "live"
      })
      .build();

    const response = await client.sendWebhookTestEvent({
      eventType: "generation.completed",
      mode: "live",
      apiKeyId: "key_123",
      samplePayload: { apiProjectId: "proj_123" }
    });
    expect(response).toEqual({
      svixMessageId: "msg_123",
      eventId: "evt_123",
      eventType: "generation.completed",
      mode: "live",
      apiKeyId: null
    });
  });

  test("account settings, keys, usage, and webhook configure endpoints", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "agent", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/account/settings/get")
      .jsonBody({})
      .respondWith()
      .statusCode(200)
      .jsonBody({
        apiKeyId: "agent_1",
        account: { userId: "user_1", billingPolicy: { type: "internalDiffio" } }
      })
      .build();

    server
      .mockEndpoint()
      .post("/v1/api_keys/create")
      .jsonBody({
        label: "VFC worker",
        scopes: ["projects:read", "projects:write"],
        resourceBounds: {}
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        key: "diffio_live_new",
        keyId: "key_1",
        label: "VFC worker",
        status: "active",
        keyPrefix: "diffio_live_",
        role: "scoped",
        scopes: ["projects:read", "projects:write"],
        resourceBounds: {},
        parentKeyId: "agent_1"
      })
      .build();

    server
      .mockEndpoint()
      .post("/v1/usage/summary")
      .jsonBody({ apiKeyId: "key_1" })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        usage: { apiKeyId: "key_1", periods: [] },
        billing: { billingPolicy: { type: "internalDiffio" } }
      })
      .build();

    server
      .mockEndpoint()
      .post("/v1/webhooks/configure")
      .jsonBody({
        mode: "live",
        url: "https://example.com/webhook",
        eventTypes: ["generation.completed"],
        apiKeyId: "key_1"
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        webhook: {
          apiKeyId: "key_1",
          mode: "live",
          endpointId: "ep_1",
          eventTypes: ["generation.completed"]
        }
      })
      .build();

    const settings = await client.account.getSettings();
    const key = await client.apiKeys.create({
      label: "VFC worker",
      scopes: ["projects:read", "projects:write"]
    });
    const usage = await client.usage.summary({ apiKeyId: "key_1" });
    const webhook = await client.webhooks.configure({
      mode: "live",
      url: "https://example.com/webhook",
      eventTypes: ["generation.completed"],
      apiKeyId: "key_1"
    });

    expect(settings.account.billingPolicy).toEqual({ type: "internalDiffio" });
    expect(key.key).toBe("diffio_live_new");
    expect(usage.billing.billingPolicy).toEqual({ type: "internalDiffio" });
    expect(webhook.webhook.endpointId).toBe("ep_1");
  });
});
