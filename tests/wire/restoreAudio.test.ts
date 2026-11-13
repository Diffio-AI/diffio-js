import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { DiffioResourceFailedError } from "../../src/errors";
import { createFakeEdgeUploadWorker } from "../mock-server/fakeEdgeUploadWorker";
import { mockServerPool } from "../mock-server/MockServerPool";
import { fakeApi, generation, project, projectWithUpload } from "./helpers";

const TOKEN = "v1.upload.signature";

function setup(finalGeneration = generation()) {
  const api = fakeApi();
  const edge = mockServerPool.createServer();
  const worker = createFakeEdgeUploadWorker({ edgeBaseUrl: edge.baseUrl, uploadToken: TOKEN, objectKey: "k", maxBytes: 2147483648, partSizeBytes: 8 });
  edge.useHandlers(...worker.handlers);
  const media = mockServerPool.createServer();
  media.useHandlers(http.get(`${media.baseUrl}/m/tok/gen_1/restored.mp3`, () => new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } })));
  api.on("post", "/projects", { status: 201, body: { ...projectWithUpload(edge.baseUrl, TOKEN), latest_generation: generation({ status: "queued" }) } });
  api.on("post", "/projects/:id/upload/complete", { body: project({ status: "ready", generation_count: 1 }) });
  const states = [generation({ status: "processing" }), finalGeneration];
  api.on("get", "/projects/:id/generations/:gid", () => ({ body: states.shift() ?? finalGeneration }));
  api.on("get", "/projects/:id/generations/:gid/media", {
    body: { object: "generation_media", project_id: "proj_1", generation_id: "gen_1", status: "complete", base_url: `${media.baseUrl}/m/tok/`, expires_at: "x", preview_seconds: null, files: { audio: `${media.baseUrl}/m/tok/gen_1/restored.mp3` } }
  });
  return { api, worker };
}

describe("restoreAudio", () => {
  test("creates with a generation, uploads, waits and writes the result", async () => {
    const { api, worker } = setup();
    const dir = mkdtempSync(join(tmpdir(), "diffio-js-restore-"));
    try {
      const input = join(dir, "interview.mp3");
      writeFileSync(input, Buffer.from("seventeen bytes!!"));
      const output = join(dir, "restored.mp3");
      const statuses: string[] = [];
      const result = await api.client().restoreAudio({
        file: input,
        outputPath: output,
        metadata: { order_id: "1042" },
        endUser: "customer-1",
        pollInterval: 0,
        onProgress: (g) => { statuses.push(g.status); }
      });
      expect(result).toMatchObject({ output_path: output, data: null, size_bytes: 3, content_type: "audio/mpeg" });
      expect(result.generation.status).toBe("complete");
      expect(result.project.status).toBe("ready");
      expect(Array.from(readFileSync(output))).toEqual([1, 2, 3]);
      expect(worker.completedObjectBytes()?.byteLength).toBe(17);
      expect(statuses).toEqual(["processing", "complete"]);
      expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /projects",
        "POST /projects/proj_1/upload/complete",
        "GET /projects/proj_1/generations/gen_1",
        "GET /projects/proj_1/generations/gen_1",
        "GET /projects/proj_1/generations/gen_1/media"
      ]);
      expect(api.requests[0].body).toEqual({
        file_name: "interview.mp3",
        content_type: "audio/mpeg",
        size_bytes: 17,
        metadata: { order_id: "1042" },
        generation: { model: "diffio-flash" }
      });
      expect(api.requests.every((r) => r.headers.get("diffio-end-user") === "customer-1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("takes bytes with file_name and returns the result bytes", async () => {
    const { api } = setup();
    const result = await api.client().restoreAudio({ file: new Uint8Array(9), file_name: "clip.wav", model: "diffio-pro", pollInterval: 0 });
    expect(Array.from(result.data ?? [])).toEqual([1, 2, 3]);
    expect(api.requests[0].body).toMatchObject({ file_name: "clip.wav", content_type: "audio/wav", size_bytes: 9, generation: { model: "diffio-pro" } });
  });

  test("bytes without file_name are refused before any request", async () => {
    const { api } = setup();
    await expect(api.client().restoreAudio({ file: new Uint8Array(3) })).rejects.toThrow(/file_name is required/);
    expect(api.requests.length).toBe(0);
  });

  test("a failed restore throws DiffioResourceFailedError", async () => {
    const { api } = setup(generation({ status: "failed", error: { code: "restoration_failed", message: "Restoration failed.", retryable: false, explanation: null } }));
    await expect(api.client().restoreAudio({ file: new Uint8Array(3), file_name: "a.mp3", pollInterval: 0 }))
      .rejects.toBeInstanceOf(DiffioResourceFailedError);
  });
});
