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
          "X-Diffio-SDK-Name": "diffio-js",
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

  test("getWebhooksPortalAccess sends payload and returns response", async () => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post("/v1/webhooks/app_portal_access")
      .headers({
        Authorization: "Bearer test",
        "Content-Type": "application/json"
      })
      .jsonBody({
        mode: "test",
        apiKeyId: "key_123"
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        portalUrl: "https://app.svix.com/app-portal/test",
        mode: "test"
      })
      .build();

    const response = await client.getWebhooksPortalAccess({ mode: "test", apiKeyId: "key_123" });
    expect(response).toEqual({
      portalUrl: "https://app.svix.com/app-portal/test",
      mode: "test",
      apiKeyId: null
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
        mode: "test",
        apiKeyId: "key_123",
        samplePayload: { apiProjectId: "proj_123" }
      })
      .respondWith()
      .statusCode(200)
      .jsonBody({
        svixMessageId: "msg_123",
        eventId: "evt_123",
        eventType: "generation.completed",
        mode: "test"
      })
      .build();

    const response = await client.sendWebhookTestEvent({
      eventType: "generation.completed",
      mode: "test",
      apiKeyId: "key_123",
      samplePayload: { apiProjectId: "proj_123" }
    });
    expect(response).toEqual({
      svixMessageId: "msg_123",
      eventId: "evt_123",
      eventType: "generation.completed",
      mode: "test",
      apiKeyId: null
    });
  });
});
