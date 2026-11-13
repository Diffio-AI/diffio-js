import {
  classifyEdgeUploadResponse,
  defaultUploadRequests,
  fillTemplate,
  fillTemplateString,
  planEdgeUploadParts,
  resolveEdgeUploadRetryDelayMs,
  uploadToMediaHost
} from "../../../src/core/edgeUpload";
import { DiffioUploadError } from "../../../src/errors";
import type { ProjectUpload } from "../../../src/api/types";

const EDGE = "https://media.example.test";
const TOKEN = "v1.payload.signature";

function upload(overrides: Partial<ProjectUpload> = {}): ProjectUpload {
  return {
    upload_session_id: "api-p1",
    edge_base_url: EDGE,
    upload_token: TOKEN,
    part_size_bytes: 4,
    max_bytes: 1000,
    expires_at: "2026-11-14T00:00:00Z",
    requests: defaultUploadRequests({ edge_base_url: EDGE, upload_token: TOKEN }),
    ...overrides
  };
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

/** A fake media host as a fetch function, with injectable part failures. */
function fakeMediaHost(options: { partFailures?: Record<number, Array<number | "network">>; partSize?: number } = {}) {
  const sent: Sent[] = [];
  const parts = new Map<number, Uint8Array>();
  const failures = new Map(Object.entries(options.partFailures ?? {}).map(([k, v]) => [Number(k), [...v]]));
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body as string | Uint8Array | undefined;
    sent.push({ method: String(init?.method), url, headers, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json({ error: { code: "invalid_token", message: "no" } }, 401);
    const path = new URL(url).pathname;
    if (path === "/v1/uploads/start") return json({ uploadId: "up-1", partSizeBytes: options.partSize ?? 4, maxBytes: 1000 });
    const partMatch = /^\/v1\/uploads\/parts\/(\d+)$/.exec(path);
    if (partMatch) {
      const number = Number(partMatch[1]);
      const failure = failures.get(number)?.shift();
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure) return json({ error: { code: "internal_error", message: "boom" } }, failure);
      parts.set(number, body as Uint8Array);
      return json({ partNumber: number, etag: `e${number}` });
    }
    if (path === "/v1/uploads/complete") {
      const parsed = JSON.parse(String(body)) as { parts: Array<{ partNumber: number; etag: string }> };
      const size = parsed.parts.reduce((total, part) => total + (parts.get(part.partNumber)?.byteLength ?? 0), 0);
      return json({ objectKey: "k", sizeBytes: size, etag: "obj" });
    }
    if (path === "/v1/uploads/abort") return json({});
    return json({ error: { code: "not_found", message: "?" } }, 404);
  }) as typeof fetch;
  return { fetchFn, sent, parts };
}

const bytesSource = (bytes: Uint8Array) => ({
  sizeBytes: bytes.byteLength,
  read: async (start: number, end: number) => bytes.subarray(start, end)
});

describe("planEdgeUploadParts", () => {
  test("splits into fixed parts numbered from 1", () => {
    expect(planEdgeUploadParts(10, 4)).toEqual([
      { partNumber: 1, startByte: 0, endByte: 4 },
      { partNumber: 2, startByte: 4, endByte: 8 },
      { partNumber: 3, startByte: 8, endByte: 10 }
    ]);
  });

  test("an empty file is one empty part", () => {
    expect(planEdgeUploadParts(0, 4)).toEqual([{ partNumber: 1, startByte: 0, endByte: 0 }]);
  });

  test("refuses bad sizes", () => {
    expect(() => planEdgeUploadParts(-1, 4)).toThrow();
    expect(() => planEdgeUploadParts(1, 0)).toThrow();
  });

  test("retry delays double and cap at 8 s", () => {
    expect([2, 3, 4, 5, 9].map(resolveEdgeUploadRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});

describe("descriptor templates", () => {
  test("a whole-placeholder string keeps the value's type", () => {
    expect(fillTemplateString("{part_number}", { part_number: 3 })).toBe(3);
    expect(fillTemplateString("/parts/{part_number}?uploadId={upload_id}", { part_number: 3, upload_id: "u" }))
      .toBe("/parts/3?uploadId=u");
    expect(fillTemplateString("{unknown}", {})).toBe("{unknown}");
  });

  test("the complete body expands one entry per part", () => {
    const template = { uploadId: "{upload_id}", parts: [{ partNumber: "{part_number}", etag: "{etag}" }] };
    expect(fillTemplate(template, { upload_id: "u" }, [{ partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }]))
      .toEqual({ uploadId: "u", parts: [{ partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }] });
  });

  test("classifies media host refusals", () => {
    const expired = classifyEdgeUploadResponse(401, JSON.stringify({ error: { code: "token_expired", message: "Expired" } }));
    expect(expired).toBeInstanceOf(DiffioUploadError);
    expect(expired).toMatchObject({ code: "token_expired", message: "Expired", status: 401, retryable: false });
    expect(classifyEdgeUploadResponse(503, "")).toMatchObject({ code: "upload_failed", retryable: true });
    expect(classifyEdgeUploadResponse(413, "")).toMatchObject({ code: "payload_too_large", retryable: false });
  });
});

describe("uploadToMediaHost", () => {
  test("follows the descriptors: start, every part, complete with numeric part numbers", async () => {
    const host = fakeMediaHost();
    const bytes = new TextEncoder().encode("0123456789");
    const progress: number[] = [];
    const result = await uploadToMediaHost({
      upload: upload(),
      source: bytesSource(bytes),
      fetch: host.fetchFn,
      partConcurrency: 1,
      onProgress: (p) => progress.push(p.bytes_sent)
    });
    expect(result).toEqual({ sizeBytes: 10, etag: "obj" });
    expect(host.sent.map((s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`)).toEqual([
      "POST /v1/uploads/start",
      "PUT /v1/uploads/parts/1?uploadId=up-1",
      "PUT /v1/uploads/parts/2?uploadId=up-1",
      "PUT /v1/uploads/parts/3?uploadId=up-1",
      "POST /v1/uploads/complete"
    ]);
    // Content-Length comes from the body; the descriptor's template value is never sent.
    expect(Object.keys(host.sent[1].headers).map((h) => h.toLowerCase())).not.toContain("content-length");
    expect(host.sent[0].body).toBeUndefined();
    expect(JSON.parse(String(host.sent[4].body))).toEqual({
      uploadId: "up-1",
      parts: [{ partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "e2" }, { partNumber: 3, etag: "e3" }]
    });
    expect(progress).toEqual([4, 8, 10]);
  });

  test("uses the descriptor URLs, not edge_base_url, when they differ", async () => {
    const host = fakeMediaHost();
    const requests = defaultUploadRequests({ edge_base_url: EDGE, upload_token: TOKEN });
    await uploadToMediaHost({
      upload: upload({ edge_base_url: "https://ignored.example.test", requests }),
      source: bytesSource(new Uint8Array(3)),
      fetch: host.fetchFn
    });
    expect(host.sent.every((s) => s.url.startsWith(EDGE))).toBe(true);
  });

  test("builds the standard descriptors when the answer has none", async () => {
    const host = fakeMediaHost();
    const answer = upload();
    delete (answer as Partial<ProjectUpload>).requests;
    await uploadToMediaHost({ upload: answer, source: bytesSource(new Uint8Array(5)), fetch: host.fetchFn });
    expect(host.sent.map((s) => new URL(s.url).pathname)).toEqual([
      "/v1/uploads/start", "/v1/uploads/parts/1", "/v1/uploads/parts/2", "/v1/uploads/complete"
    ]);
  });

  test("retries a part after a 503 and a network failure", async () => {
    const host = fakeMediaHost({ partFailures: { 2: [503, "network"] } });
    const delays: number[] = [];
    await uploadToMediaHost({
      upload: upload(),
      source: bytesSource(new Uint8Array(10)),
      fetch: host.fetchFn,
      partConcurrency: 1,
      sleep: async (ms) => { delays.push(ms); }
    });
    expect(host.sent.filter((s) => s.url.includes("/parts/2")).length).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test("a part that keeps failing aborts the upload and throws", async () => {
    const host = fakeMediaHost({ partFailures: { 1: [500, 500, 500, 500] } });
    await expect(uploadToMediaHost({
      upload: upload(),
      source: bytesSource(new Uint8Array(3)),
      fetch: host.fetchFn,
      sleep: async () => undefined
    })).rejects.toMatchObject({ name: "DiffioUploadError", status: 500, retryable: true });
    expect(host.sent.at(-1)?.url).toBe(`${EDGE}/v1/uploads/abort`);
    expect(JSON.parse(String(host.sent.at(-1)?.body))).toEqual({ uploadId: "up-1" });
  });

  test("a refused token is final", async () => {
    const host = fakeMediaHost();
    await expect(uploadToMediaHost({
      upload: upload({ upload_token: "wrong", requests: defaultUploadRequests({ edge_base_url: EDGE, upload_token: "wrong" }) }),
      source: bytesSource(new Uint8Array(3)),
      fetch: host.fetchFn,
      sleep: async () => undefined
    })).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    expect(host.sent.length).toBe(1);
  });

  test("refuses a file over max_bytes before sending anything", async () => {
    const host = fakeMediaHost();
    await expect(uploadToMediaHost({ upload: upload({ max_bytes: 2 }), source: bytesSource(new Uint8Array(3)), fetch: host.fetchFn }))
      .rejects.toMatchObject({ code: "too_large" });
    expect(host.sent.length).toBe(0);
  });
});
