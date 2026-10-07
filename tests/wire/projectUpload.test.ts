import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { DiffioClient } from "../../src/Client";
import { DiffioApiError, DiffioUploadError } from "../../src/errors";
import { DIFFIO_SDK_VERSION } from "../../src/version";
import { createFakeEdgeUploadWorker } from "../mock-server/fakeEdgeUploadWorker";
import { mockServerPool } from "../mock-server/MockServerPool";

const UPLOAD_TOKEN = "v1.upload-token.signature";
const OBJECT_KEY = "api/users/user_1/projects/proj_123/original/demo.wav";

function createProjectResponse(edgeBaseUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiProjectId: "proj_123",
    upload: {
      uploadSessionId: "api-proj_123",
      edgeBaseUrl,
      uploadToken: UPLOAD_TOKEN,
      objectKey: OBJECT_KEY,
      partSizeBytes: 33554432,
      maxBytes: 2147483648,
      expiresAt: "2026-10-08T12:00:00Z",
      ...overrides
    },
    objectPath: OBJECT_KEY,
    expiresAt: "2026-10-08T12:00:00Z"
  };
}

function writeTempFile(name: string, contents: Buffer): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "diffio-sdk-upload-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, contents);
  return { dir, filePath };
}

describe("project upload through the edge Worker", () => {
  test("createProject uploads every part with the upload token and confirms the upload", async () => {
    const contents = Buffer.from("twenty bytes of wav!", "utf8");
    const { dir, filePath } = writeTempFile("demo.wav", contents);
    const api = mockServerPool.createServer();
    const edge = mockServerPool.createServer();
    const fakeEdge = createFakeEdgeUploadWorker({
      edgeBaseUrl: edge.baseUrl,
      uploadToken: UPLOAD_TOKEN,
      objectKey: OBJECT_KEY,
      maxBytes: 2147483648,
      partSizeBytes: 8
    });
    edge.useHandlers(...fakeEdge.handlers);
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api
        .mockEndpoint()
        .post("/v1/create_project")
        .headers({
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "X-Diffio-SDK-Version": DIFFIO_SDK_VERSION
        })
        .jsonBody({ fileName: "demo.wav", contentType: "audio/wave", contentLength: contents.byteLength })
        .respondWith()
        .statusCode(200)
        .jsonBody(createProjectResponse(`${edge.baseUrl}/`))
        .build();
      api
        .mockEndpoint()
        .post("/v1/complete_project_upload")
        .headers({ Authorization: "Bearer test", "Content-Type": "application/json" })
        .jsonBody({ apiProjectId: "proj_123" })
        .respondWith()
        .statusCode(200)
        .jsonBody({ apiProjectId: "proj_123", status: "uploaded", sizeBytes: contents.byteLength })
        .build();

      const project = await client.createProject({ filePath });

      expect(Buffer.from(fakeEdge.completedObjectBytes() ?? [])).toEqual(contents);
      expect(fakeEdge.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /v1/uploads/start",
        expect.stringMatching(/^PUT \/v1\/uploads\/parts\/[123]\?uploadId=edge-upload-1$/),
        expect.stringMatching(/^PUT \/v1\/uploads\/parts\/[123]\?uploadId=edge-upload-1$/),
        expect.stringMatching(/^PUT \/v1\/uploads\/parts\/[123]\?uploadId=edge-upload-1$/),
        "POST /v1/uploads/complete"
      ]);
      expect(fakeEdge.requests.every((request) => request.authorization === `Bearer ${UPLOAD_TOKEN}`)).toBe(true);
      const partRequests = fakeEdge.requests.filter((request) => request.method === "PUT");
      expect(partRequests.map((request) => request.contentType)).toEqual(Array(3).fill("application/octet-stream"));
      expect(partRequests.map((request) => request.bodyBytes).sort()).toEqual([4, 8, 8]);
      expect(project).toEqual({
        apiProjectId: "proj_123",
        upload: {
          uploadSessionId: "api-proj_123",
          edgeBaseUrl: edge.baseUrl,
          objectKey: OBJECT_KEY,
          partSizeBytes: 33554432,
          maxBytes: 2147483648,
          expiresAt: "2026-10-08T12:00:00Z"
        },
        objectPath: OBJECT_KEY,
        expiresAt: "2026-10-08T12:00:00Z",
        uploadCompletion: { apiProjectId: "proj_123", status: "uploaded", sizeBytes: contents.byteLength }
      });
      expect(JSON.stringify(project)).not.toContain(UPLOAD_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a part that fails with a retryable status is sent again", async () => {
    const contents = Buffer.from("0123456789abcdef", "utf8");
    const { dir, filePath } = writeTempFile("retry.mp3", contents);
    const api = mockServerPool.createServer();
    const edge = mockServerPool.createServer();
    const fakeEdge = createFakeEdgeUploadWorker({
      edgeBaseUrl: edge.baseUrl,
      uploadToken: UPLOAD_TOKEN,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
      partSizeBytes: 8,
      partFailureStatuses: { 2: [503] }
    });
    edge.useHandlers(...fakeEdge.handlers);
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200)
        .jsonBody(createProjectResponse(edge.baseUrl)).build();
      api.mockEndpoint().post("/v1/complete_project_upload").respondWith().statusCode(200)
        .jsonBody({ apiProjectId: "proj_123", status: "uploaded", sizeBytes: contents.byteLength }).build();

      await client.createProject({ filePath });

      expect(Buffer.from(fakeEdge.completedObjectBytes() ?? [])).toEqual(contents);
      const partTwoAttempts = fakeEdge.requests.filter((request) => request.path.startsWith("/v1/uploads/parts/2?"));
      expect(partTwoAttempts).toHaveLength(2);
      expect(fakeEdge.abortedUploadIds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused part aborts the multipart upload and skips upload confirmation", async () => {
    const contents = Buffer.from("0123456789abcdef", "utf8");
    const { dir, filePath } = writeTempFile("refused.wav", contents);
    const api = mockServerPool.createServer();
    const edge = mockServerPool.createServer();
    const fakeEdge = createFakeEdgeUploadWorker({
      edgeBaseUrl: edge.baseUrl,
      uploadToken: UPLOAD_TOKEN,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
      partSizeBytes: 8,
      partFailureStatuses: { 1: [400] }
    });
    edge.useHandlers(...fakeEdge.handlers);
    const completeCalls: unknown[] = [];
    api.useHandlers(
      http.post(`${api.baseUrl}/v1/complete_project_upload`, async ({ request }) => {
        completeCalls.push(await request.json());
        return HttpResponse.json({ apiProjectId: "proj_123", status: "uploaded", sizeBytes: 16 });
      })
    );
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200)
        .jsonBody(createProjectResponse(edge.baseUrl)).build();

      const error = await client.createProject({ filePath }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DiffioUploadError);
      expect(error).toBeInstanceOf(DiffioApiError);
      expect(error).toMatchObject({
        uploadErrorCode: "upload/rejected",
        statusCode: 400,
        message: "Injected part 1 failure",
        apiProjectId: "proj_123"
      });
      expect(fakeEdge.requests.filter((request) => request.path.startsWith("/v1/uploads/parts/1?"))).toHaveLength(1);
      expect(fakeEdge.abortedUploadIds).toEqual(["edge-upload-1"]);
      expect(fakeEdge.completedObjectBytes()).toBeNull();
      expect(completeCalls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file larger than the session limit is refused before any edge request", async () => {
    const contents = Buffer.alloc(32, 1);
    const { dir, filePath } = writeTempFile("large.wav", contents);
    const api = mockServerPool.createServer();
    const edge = mockServerPool.createServer();
    const fakeEdge = createFakeEdgeUploadWorker({
      edgeBaseUrl: edge.baseUrl,
      uploadToken: UPLOAD_TOKEN,
      objectKey: OBJECT_KEY,
      maxBytes: 16,
      partSizeBytes: 8
    });
    edge.useHandlers(...fakeEdge.handlers);
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200)
        .jsonBody(createProjectResponse(edge.baseUrl, { maxBytes: 16 })).build();

      await expect(client.createProject({ filePath })).rejects.toMatchObject({
        name: "DiffioUploadError",
        uploadErrorCode: "upload/too-large"
      });
      expect(fakeEdge.requests).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a create_project response without an upload session is reported, not uploaded to undefined", async () => {
    const { dir, filePath } = writeTempFile("legacy.wav", Buffer.from("legacy"));
    const api = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200)
        .jsonBody({ apiProjectId: "proj_old", uploadUrl: "https://storage.example/put", uploadMethod: "PUT" })
        .build();

      await expect(client.createProject({ filePath })).rejects.toMatchObject({
        name: "DiffioUploadError",
        uploadErrorCode: "upload/invalid-response",
        apiProjectId: "proj_old"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edge part requests over a real socket", () => {
  let edgeServer: Server;
  let edgeBaseUrl: string;
  const partContentLengths: Array<string | undefined> = [];

  const readBody = async (request: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  beforeAll(async () => {
    // Mirrors the edge's checkUploadBodyLength: R2 needs a declared length, so chunked parts get 411.
    edgeServer = createServer(async (request, response) => {
      const body = await readBody(request);
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const url = new URL(request.url ?? "/", "http://edge.local");
      if (url.pathname === "/v1/uploads/start") return send(200, { uploadId: "socket-upload", partSizeBytes: 8, maxBytes: 64 });
      if (url.pathname.startsWith("/v1/uploads/parts/")) {
        partContentLengths.push(request.headers["content-length"]);
        if (request.headers["content-length"] == null) {
          return send(411, { error: { code: "bad_request", message: "Parts need a Content-Length" } });
        }
        return send(200, { partNumber: Number(url.pathname.split("/").pop()), etag: `etag-${body.byteLength}` });
      }
      if (url.pathname === "/v1/uploads/complete") return send(200, { objectKey: OBJECT_KEY, sizeBytes: 12, etag: "e" });
      return send(404, { error: { code: "not_found", message: "Unknown upload route" } });
    });
    await new Promise<void>((resolve) => edgeServer.listen(0, "127.0.0.1", resolve));
    edgeBaseUrl = `http://127.0.0.1:${(edgeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  });

  test("every part declares its Content-Length", async () => {
    const { dir, filePath } = writeTempFile("socket.wav", Buffer.from("twelve bytes", "utf8"));
    const api = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: api.baseUrl, maxRetries: 0 });

    try {
      api.mockEndpoint().post("/v1/create_project").respondWith().statusCode(200)
        .jsonBody(createProjectResponse(edgeBaseUrl)).build();
      api.mockEndpoint().post("/v1/complete_project_upload").respondWith().statusCode(200)
        .jsonBody({ apiProjectId: "proj_123", status: "uploaded", sizeBytes: 12 }).build();

      await client.createProject({ filePath });

      expect(partContentLengths.sort()).toEqual(["4", "8"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
