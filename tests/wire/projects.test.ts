import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffioUploadError } from "../../src/errors";
import { createFakeEdgeUploadWorker } from "../mock-server/fakeEdgeUploadWorker";
import { mockServerPool } from "../mock-server/MockServerPool";
import { errorBody, fakeApi, generation, project, projectWithUpload } from "./helpers";

const TOKEN = "v1.upload.signature";

function fakeEdge(partSizeBytes = 8, partFailureStatuses?: Record<number, number[]>) {
  const edge = mockServerPool.createServer();
  const worker = createFakeEdgeUploadWorker({
    edgeBaseUrl: edge.baseUrl,
    uploadToken: TOKEN,
    objectKey: "api/users/u/projects/proj_1/original/interview.mp3",
    maxBytes: 2147483648,
    partSizeBytes,
    partFailureStatuses
  });
  edge.useHandlers(...worker.handlers);
  return { edge, worker };
}

describe("projects", () => {
  test("create sends snake_case fields as given and returns the project with upload", async () => {
    const api = fakeApi();
    const { edge } = fakeEdge();
    api.on("post", "/projects", { status: 201, body: projectWithUpload(edge.baseUrl, TOKEN) });
    const created = await api.client().projects.create(
      {
        file_name: "interview.mp3",
        content_type: "audio/mpeg",
        size_bytes: 510957,
        metadata: { order_id: "1042" },
        generation: { model: "diffio-flash", label: "first" }
      },
      { idempotencyKey: "order-1042" }
    );
    expect(created.upload?.requests.part.method).toBe("PUT");
    const request = api.requests[0];
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("idempotency-key")).toBe("order-1042");
    expect(request.body).toEqual({
      file_name: "interview.mp3",
      content_type: "audio/mpeg",
      size_bytes: 510957,
      metadata: { order_id: "1042" },
      generation: { model: "diffio-flash", label: "first" }
    });
  });

  test("create moves end_user to the Diffio-End-User header, never the body", async () => {
    const api = fakeApi();
    api.on("post", "/projects", { status: 201, body: projectWithUpload("https://edge.test", TOKEN, { end_user: "customer-42" }) });
    await api.client().projects.create({ file_name: "a.wav", end_user: "customer-42" });
    expect(api.requests[0].headers.get("diffio-end-user")).toBe("customer-42");
    expect(api.requests[0].body).toEqual({ file_name: "a.wav" });
  });

  test("create needs file_name", async () => {
    const api = fakeApi();
    await expect(api.client().projects.create({ file_name: " " })).rejects.toThrow("file_name is required");
    expect(api.requests.length).toBe(0);
  });

  test("list returns a page; for await walks every page with cursor", async () => {
    const api = fakeApi();
    api.on("get", "/projects", (request) => {
      const cursor = new URLSearchParams(request.search).get("cursor");
      if (!cursor) return { body: { object: "list", data: [project({ id: "p3" }), project({ id: "p2" })], next_cursor: "p2" } };
      return { body: { object: "list", data: [project({ id: "p1" })], next_cursor: null } };
    });
    const client = api.client();
    const page = await client.projects.list({ limit: 2 });
    expect(page.data.map((p) => p.id)).toEqual(["p3", "p2"]);
    expect(page.next_cursor).toBe("p2");
    expect(api.requests[0].search).toBe("?limit=2");

    const ids: string[] = [];
    for await (const item of client.projects.list({ limit: 2 })) ids.push(item.id);
    expect(ids).toEqual(["p3", "p2", "p1"]);
    expect(api.requests.at(-1)?.search).toBe("?limit=2&cursor=p2");
  });

  test("get, delete, reopenUpload and completeUpload hit their routes", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    api.on("delete", "/projects/:id", { body: { id: "proj_1", object: "project", deleted: true, deleted_generations: 2, deleted_media_objects: 7 } });
    api.on("post", "/projects/:id/upload", { body: projectWithUpload("https://edge.test", TOKEN) });
    api.on("post", "/projects/:id/upload/complete", { body: project({ status: "ready" }) });
    const client = api.client();
    expect((await client.projects.get("proj_1")).object).toBe("project");
    expect(await client.projects.delete("proj_1")).toMatchObject({ deleted: true, deleted_generations: 2 });
    expect((await client.projects.reopenUpload("proj_1")).upload?.upload_token).toBe(TOKEN);
    expect((await client.projects.completeUpload("proj_1")).status).toBe("ready");
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /projects/proj_1",
      "DELETE /projects/proj_1",
      "POST /projects/proj_1/upload",
      "POST /projects/proj_1/upload/complete"
    ]);
    expect(api.requests[3].body).toBeUndefined();
  });

  test("completeUpload is retried (safe to repeat)", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/upload/complete", { body: project() });
    api.on("post", "/projects/:id/upload/complete", { status: 503, body: errorBody("unavailable", "storage") }, { once: true });
    await api.client({ maxRetries: 0 }).projects.completeUpload("proj_1");
    expect(api.requests.length).toBe(2);
  });

  test("upload of a file path follows upload.requests in parts, then completes the upload", async () => {
    const api = fakeApi();
    const { edge, worker } = fakeEdge(8);
    api.on("post", "/projects/:id/upload/complete", { body: project({ status: "ready" }) });
    const contents = Buffer.from("twenty bytes of mp3!");
    const dir = mkdtempSync(join(tmpdir(), "diffio-js-"));
    const filePath = join(dir, "interview.mp3");
    writeFileSync(filePath, contents);
    try {
      const progress: number[] = [];
      const result = await api.client().projects.upload(projectWithUpload(edge.baseUrl, TOKEN), filePath, {
        onUploadProgress: (p) => progress.push(p.parts_done)
      });
      expect(result.status).toBe("ready");
      expect(Buffer.from(worker.completedObjectBytes() ?? [])).toEqual(contents);
      expect(worker.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual(expect.arrayContaining([
        "POST /v1/uploads/start", "PUT /v1/uploads/parts/1", "PUT /v1/uploads/parts/2", "PUT /v1/uploads/parts/3", "POST /v1/uploads/complete"
      ]));
      // The media host sees only the upload token, never the API key.
      expect(worker.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(progress.sort()).toEqual([1, 2, 3]);
      expect(api.requests.map((r) => r.path)).toEqual(["/projects/proj_1/upload/complete"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upload takes a Blob, a Buffer or a Uint8Array", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/upload/complete", { body: project() });
    for (const input of [new Blob([Buffer.from("blob bytes, 15")]), Buffer.from("buffer bytes"), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]) {
      const { edge, worker } = fakeEdge(4);
      await api.client().projects.upload(projectWithUpload(edge.baseUrl, TOKEN), input);
      const expected = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : new Uint8Array(input);
      expect(new Uint8Array(worker.completedObjectBytes() ?? [])).toEqual(expected);
    }
  });

  test("upload with complete: false reads the project instead of completing", async () => {
    const api = fakeApi();
    const { edge } = fakeEdge();
    api.on("get", "/projects/:id", { body: project({ status: "preparing" }) });
    const result = await api.client().projects.upload(projectWithUpload(edge.baseUrl, TOKEN), Buffer.from("x"), { complete: false });
    expect(result.status).toBe("preparing");
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /projects/proj_1"]);
  });

  test("upload given a project id fetches fresh instructions with reopenUpload", async () => {
    const api = fakeApi();
    const { edge, worker } = fakeEdge();
    api.on("post", "/projects/:id/upload", { body: projectWithUpload(edge.baseUrl, TOKEN) });
    api.on("post", "/projects/:id/upload/complete", { body: project() });
    await api.client().projects.upload("proj_1", Buffer.from("abc"));
    expect(api.requests.map((r) => r.path)).toEqual(["/projects/proj_1/upload", "/projects/proj_1/upload/complete"]);
    expect(worker.completedObjectBytes()?.byteLength).toBe(3);
  });

  test("a failed part is retried; a part that keeps failing aborts and names the project", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/upload/complete", { body: project() });
    const flaky = fakeEdge(8, { 1: [503] });
    await api.client().projects.upload(projectWithUpload(flaky.edge.baseUrl, TOKEN), Buffer.from("abc"));
    expect(flaky.worker.requests.filter((r) => r.path.startsWith("/v1/uploads/parts/1")).length).toBe(2);

    const broken = fakeEdge(8, { 1: [400] });
    const error = await api.client().projects.upload(projectWithUpload(broken.edge.baseUrl, TOKEN), Buffer.from("abc")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiffioUploadError);
    expect(error).toMatchObject({ status: 400, project_id: "proj_1", retryable: false });
    expect(broken.worker.abortedUploadIds).toEqual(["edge-upload-1"]);
  });

  test("upload refuses a project without instructions", async () => {
    const api = fakeApi();
    await expect(api.client().projects.upload({ ...project(), upload: null }, Buffer.from("x"))).rejects.toThrow(/no upload instructions/);
  });

  test("create with generation returns latest_generation", async () => {
    const api = fakeApi();
    api.on("post", "/projects", { status: 201, body: { ...projectWithUpload("https://edge.test", TOKEN), latest_generation: generation({ status: "queued" }) } });
    const created = await api.client().projects.create({ file_name: "a.mp3", generation: { model: "diffio-pro" } });
    expect(created.latest_generation?.status).toBe("queued");
  });
});
