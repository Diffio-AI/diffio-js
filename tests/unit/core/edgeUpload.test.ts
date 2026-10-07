import {
  classifyEdgeUploadResponse,
  parseEdgeUploadSession,
  planEdgeUploadParts,
  resolveEdgeUploadRetryDelayMs,
  uploadProjectMediaToEdge,
  type EdgeUploadHttpRequest,
  type EdgeUploadHttpResponse,
  type EdgeUploadSession
} from "../../../src/core/edgeUpload";
import { DiffioUploadError } from "../../../src/errors";

const session: EdgeUploadSession = {
  uploadSessionId: "api-proj_1",
  edgeBaseUrl: "https://edge.example.com",
  uploadToken: "upload-token",
  objectKey: "api/users/u/projects/proj_1/original/a.wav",
  partSizeBytes: 4,
  maxBytes: 64,
  expiresAt: "2026-10-08T00:00:00Z"
};

const json = (status: number, body: unknown): EdgeUploadHttpResponse => ({ status, bodyText: JSON.stringify(body) });

/** A scripted edge: `parts` answers per part number, consumed one per attempt, defaulting to success. */
function scriptedEdge(options: { parts?: Record<number, Array<EdgeUploadHttpResponse | Error>>; completeSizeBytes?: number } = {}) {
  const requests: EdgeUploadHttpRequest[] = [];
  const scripts = new Map(Object.entries(options.parts ?? {}).map(([key, value]) => [Number(key), [...value]]));
  const sendEdgeRequest = async (request: EdgeUploadHttpRequest): Promise<EdgeUploadHttpResponse> => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/v1/uploads/start") return json(200, { uploadId: "u-1", partSizeBytes: 4, maxBytes: 64 });
    if (url.pathname.startsWith("/v1/uploads/parts/")) {
      const partNumber = Number(url.pathname.split("/").pop());
      const next = scripts.get(partNumber)?.shift();
      if (next instanceof Error) throw next;
      return next ?? json(200, { partNumber, etag: `etag-${partNumber}` });
    }
    if (url.pathname === "/v1/uploads/complete") {
      return json(200, { objectKey: session.objectKey, sizeBytes: options.completeSizeBytes ?? 10, etag: "obj" });
    }
    return json(200, {});
  };
  return { requests, sendEdgeRequest };
}

const media = Buffer.from("0123456789");
const readPartBytes = async (startByte: number, endByte: number): Promise<Uint8Array> => media.subarray(startByte, endByte);

describe("edge upload protocol", () => {
  test("plans fixed-size parts numbered from 1, and one empty part for an empty file", () => {
    expect(planEdgeUploadParts(10, 4)).toEqual([
      { partNumber: 1, startByte: 0, endByte: 4 },
      { partNumber: 2, startByte: 4, endByte: 8 },
      { partNumber: 3, startByte: 8, endByte: 10 }
    ]);
    expect(planEdgeUploadParts(0, 4)).toEqual([{ partNumber: 1, startByte: 0, endByte: 0 }]);
  });

  test("backs off 1 s, 2 s, 4 s and caps at 8 s", () => {
    expect([2, 3, 4, 5, 6].map(resolveEdgeUploadRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  test("rejects an incomplete upload session", () => {
    expect(parseEdgeUploadSession({ ...session, uploadToken: "" })).toBeNull();
    expect(parseEdgeUploadSession({ ...session, edgeBaseUrl: "edge.example.com" })).toBeNull();
    expect(parseEdgeUploadSession(undefined)).toBeNull();
    expect(parseEdgeUploadSession({ ...session, edgeBaseUrl: "https://edge.example.com//" })?.edgeBaseUrl)
      .toBe("https://edge.example.com");
  });

  test.each([
    [413, "upload/too-large", false],
    [401, "upload/unauthorized", false],
    [403, "upload/unauthorized", false],
    [400, "upload/rejected", false],
    [429, "upload/server", true],
    [503, "upload/server", true]
  ] as const)("classifies HTTP %s as %s", (status, code, retryable) => {
    const error = classifyEdgeUploadResponse(json(status, { error: { code: "token_expired", message: "Upload token refused" } }));
    expect(error).toMatchObject({ uploadErrorCode: code, retryable, statusCode: status, edgeErrorCode: "token_expired" });
    expect(error.message).toBe("Upload token refused");
  });

  test("sends start, every part with the bearer token, and completes with sorted receipts", async () => {
    const edge = scriptedEdge();
    const completion = await uploadProjectMediaToEdge({ session, sizeBytes: 10, readPartBytes, sendEdgeRequest: edge.sendEdgeRequest });

    expect(completion).toEqual({ objectKey: session.objectKey, sizeBytes: 10, etag: "obj" });
    expect(edge.requests.every((request) => request.bearerToken === "upload-token")).toBe(true);
    const complete = edge.requests.find((request) => request.url.endsWith("/v1/uploads/complete"));
    expect(JSON.parse(String(complete?.body))).toEqual({
      uploadId: "u-1",
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 3, etag: "etag-3" }
      ]
    });
  });

  test("retries network failures and retryable statuses with backoff, then succeeds", async () => {
    const edge = scriptedEdge({ parts: { 2: [new TypeError("fetch failed"), json(502, {})] } });
    const delays: number[] = [];
    await uploadProjectMediaToEdge({
      session,
      sizeBytes: 10,
      readPartBytes,
      sendEdgeRequest: edge.sendEdgeRequest,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      }
    });

    expect(edge.requests.filter((request) => request.url.includes("/parts/2?"))).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test("gives up after four attempts and aborts the multipart upload", async () => {
    const edge = scriptedEdge({ parts: { 1: [json(503, {}), json(503, {}), json(503, {}), json(503, {})] } });
    const error = await uploadProjectMediaToEdge({
      session,
      sizeBytes: 10,
      readPartBytes,
      sendEdgeRequest: edge.sendEdgeRequest,
      partConcurrency: 1,
      sleep: async () => undefined
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiffioUploadError);
    expect(error).toMatchObject({ uploadErrorCode: "upload/server", statusCode: 503 });
    expect(edge.requests.filter((request) => request.url.includes("/parts/1?"))).toHaveLength(4);
    expect(edge.requests.at(-1)?.url).toBe("https://edge.example.com/v1/uploads/abort");
    expect(edge.requests.some((request) => request.url.endsWith("/v1/uploads/complete"))).toBe(false);
  });

  test("a caller abort is final and is not retried", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const edge = scriptedEdge({ parts: { 1: [abort] } });
    await expect(uploadProjectMediaToEdge({
      session,
      sizeBytes: 10,
      readPartBytes,
      sendEdgeRequest: edge.sendEdgeRequest,
      partConcurrency: 1,
      sleep: async () => undefined
    })).rejects.toMatchObject({ uploadErrorCode: "upload/canceled" });
    expect(edge.requests.filter((request) => request.url.includes("/parts/1?"))).toHaveLength(1);
  });

  test("a stored size that differs from the file is reported", async () => {
    const edge = scriptedEdge({ completeSizeBytes: 9 });
    await expect(uploadProjectMediaToEdge({ session, sizeBytes: 10, readPartBytes, sendEdgeRequest: edge.sendEdgeRequest }))
      .rejects.toMatchObject({ uploadErrorCode: "upload/invalid-response" });
  });
});
