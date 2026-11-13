import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { DiffioResourceFailedError, DiffioTimeoutError } from "../../src/errors";
import { mockServerPool } from "../mock-server/MockServerPool";
import { errorBody, fakeApi, generation } from "./helpers";

function mediaHost(files: Record<string, Uint8Array | number>) {
  const host = mockServerPool.createServer();
  const hits: string[] = [];
  host.useHandlers(http.get(`${host.baseUrl}/m/:token/*`, ({ request }) => {
    const url = new URL(request.url);
    hits.push(`${url.pathname} auth=${request.headers.get("authorization") ?? "none"}`);
    const name = url.pathname.split("/").pop() as string;
    const entry = files[name];
    if (typeof entry === "number") return new HttpResponse(null, { status: entry });
    if (!entry) return HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    return new HttpResponse(entry, { headers: { "Content-Type": "audio/mpeg" } });
  }));
  return { base: `${host.baseUrl}/m/token123/`, hits };
}

function media(base: string, files: Record<string, string>, status = "complete") {
  return {
    object: "generation_media",
    project_id: "proj_1",
    generation_id: "gen_1",
    status,
    files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, `${base}${path}`])),
    base_url: base,
    expires_at: "2026-11-13T06:33:41Z",
    preview_seconds: null
  };
}

describe("generations", () => {
  test("create sends model, label and sampling with an Idempotency-Key", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/generations", { status: 201, body: generation({ status: "queued" }) });
    const result = await api.client().generations.create("proj_1", { model: "diffio-pro", label: "take 2", sampling: { steps: 8 } });
    expect(result.status).toBe("queued");
    expect(api.requests[0].path).toBe("/projects/proj_1/generations");
    expect(api.requests[0].body).toEqual({ model: "diffio-pro", label: "take 2", sampling: { steps: 8 } });
    expect(api.requests[0].headers.get("idempotency-key")).toBeTruthy();
  });

  test("create needs a model", async () => {
    const api = fakeApi();
    await expect(api.client().generations.create("proj_1", { model: "" })).rejects.toThrow("model is required");
  });

  test("list pages with cursor; get reads one", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations", (request) => new URLSearchParams(request.search).get("cursor")
      ? { body: { object: "list", data: [generation({ id: "g1" })], next_cursor: null } }
      : { body: { object: "list", data: [generation({ id: "g2" })], next_cursor: "g2" } });
    api.on("get", "/projects/:id/generations/:gid", { body: generation({ id: "g2" }) });
    const client = api.client();
    const ids: string[] = [];
    for await (const item of client.generations.list("proj_1", { limit: 1 })) ids.push(item.id);
    expect(ids).toEqual(["g2", "g1"]);
    expect(api.requests[1].search).toBe("?limit=1&cursor=g2");
    expect((await client.generations.get("proj_1", "g2")).id).toBe("g2");
    expect(api.requests.at(-1)?.path).toBe("/projects/proj_1/generations/g2");
  });

  test("wait polls until complete and reports progress", async () => {
    const api = fakeApi();
    const states = [
      generation({ status: "queued", stage: "queued", queue: { position: 1, connected_workers: 1, idle_workers: 0, busy_workers: 1, wait_reason: "all_busy", message: "Queued: 1 ahead" } }),
      generation({ status: "processing", stage: "restoring", stage_progress: { overall_percent: 50 } }),
      generation()
    ];
    api.on("get", "/projects/:id/generations/:gid", () => ({ body: states.shift() ?? generation() }));
    const seen: string[] = [];
    const result = await api.client().generations.wait("proj_1", "gen_1", { pollInterval: 0, onProgress: (g) => { seen.push(g.status); } });
    expect(result.status).toBe("complete");
    expect(seen).toEqual(["queued", "processing", "complete"]);
  });

  test("wait throws DiffioResourceFailedError for a failed generation", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations/:gid", {
      body: generation({ status: "failed", stage: "failed", error: { code: "no_speech_detected", message: "No speech was found.", retryable: false, explanation: null } })
    });
    const error = await api.client().generations.wait("proj_1", "gen_1", { pollInterval: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiffioResourceFailedError);
    expect(error).toMatchObject({ code: "no_speech_detected", message: "No speech was found." });
    expect((error as DiffioResourceFailedError).resource).toMatchObject({ id: "gen_1", status: "failed" });
  });

  test("wait times out", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations/:gid", { body: generation({ status: "processing" }) });
    await expect(api.client().generations.wait("proj_1", "gen_1", { pollInterval: 0.01, timeout: 0.05 })).rejects.toBeInstanceOf(DiffioTimeoutError);
  });

  test("media sends preview_seconds as a query parameter", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations/:gid/media", { body: media("https://m.test/m/t/", { hls_master: "g/hls/master.m3u8" }) });
    const result = await api.client().generations.media("proj_1", "gen_1", { preview_seconds: 8 });
    expect(result.files.hls_master).toBe("https://m.test/m/t/g/hls/master.m3u8");
    expect(api.requests[0].search).toBe("?preview_seconds=8");
    await api.client().generations.media("proj_1", "gen_1");
    expect(api.requests[1].search).toBe("");
  });

  test("download returns the bytes of files.audio, fetched without the API key", async () => {
    const api = fakeApi();
    const host = mediaHost({ "restored.mp3": new Uint8Array([73, 68, 51, 4]) });
    api.on("get", "/projects/:id/generations/:gid/media", { body: media(host.base, { audio: "g/restored.mp3", original: "original/a.mp3" }) });
    const result = await api.client().generations.download("proj_1", "gen_1");
    expect(result).toMatchObject({ file: "audio", path: null, size_bytes: 4, content_type: "audio/mpeg" });
    expect(Array.from(result.data ?? [])).toEqual([73, 68, 51, 4]);
    expect(host.hits).toEqual(["/m/token123/g/restored.mp3 auth=none"]);
  });

  test("download streams to a path and can pick another file; a 503 is retried", async () => {
    const api = fakeApi();
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const host = mediaHost({ "word_timestamps.json": bytes });
    api.on("get", "/projects/:id/generations/:gid/media", { body: media(host.base, { transcript: "g/word_timestamps.json" }) });
    let first = true;
    const fetchWithOne503 = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/m/") && first) {
        first = false;
        return new Response("busy", { status: 503 });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "diffio-js-dl-"));
    try {
      const target = join(dir, "nested", "transcript.json");
      const result = await api.client({ fetch: fetchWithOne503 }).generations.download("proj_1", "gen_1", { file: "transcript", path: target });
      expect(result).toMatchObject({ file: "transcript", path: target, data: null, size_bytes: 100_000 });
      expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download explains a missing file", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations/:gid/media", { body: media("https://m.test/m/t/", { hls_master: "x.m3u8" }, "processing") });
    await expect(api.client().generations.download("proj_1", "gen_1")).rejects.toThrow(/no "audio" file yet \(status processing; files: hls_master\)/);
  });

  test("download surfaces a media host refusal", async () => {
    const api = fakeApi();
    const host = mediaHost({ "restored.mp3": 403 });
    api.on("get", "/projects/:id/generations/:gid/media", { body: media(host.base, { audio: "g/restored.mp3" }) });
    await expect(api.client().generations.download("proj_1", "gen_1")).rejects.toMatchObject({ name: "DiffioApiError", status: 403 });
  });

  test("a missing generation is a typed 404", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/generations/:gid", { status: 404, body: errorBody("generation_not_found", "No generation.", { generation_id: "x" }) });
    await expect(api.client().generations.get("proj_1", "x")).rejects.toMatchObject({ status: 404, code: "generation_not_found", details: { generation_id: "x" } });
  });
});
