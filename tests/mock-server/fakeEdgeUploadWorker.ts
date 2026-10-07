import { HttpResponse, http, type HttpHandler } from "msw";

/** One request the fake edge received, for asserting the SDK's wire behavior. */
export interface FakeEdgeUploadRequest {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  bodyBytes: number;
}

/** Options for a fake of the edge Worker's `/v1/uploads/*` routes (edge/src/uploadRoutes.ts in diffio-ui). */
export interface FakeEdgeUploadWorkerOptions {
  edgeBaseUrl: string;
  uploadToken: string;
  objectKey: string;
  maxBytes: number;
  /** Part size the fake's `start` answers with; small values let tests cover several parts cheaply. */
  partSizeBytes: number;
  /** HTTP statuses to answer for a part before it succeeds, consumed one per attempt. */
  partFailureStatuses?: Record<number, number[]>;
}

/** Stateful fake of the edge upload Worker: start, parts, complete, and abort with bearer upload tokens. */
export interface FakeEdgeUploadWorker {
  handlers: HttpHandler[];
  requests: FakeEdgeUploadRequest[];
  /** Bytes of the completed object, or null before `complete` succeeds. */
  completedObjectBytes: () => Uint8Array | null;
  abortedUploadIds: string[];
}

const edgeError = (status: number, code: string, message: string): Response =>
  HttpResponse.json({ error: { code, message } }, { status });

/** Builds MSW handlers that enforce the same rules as the production edge upload routes. */
export function createFakeEdgeUploadWorker(options: FakeEdgeUploadWorkerOptions): FakeEdgeUploadWorker {
  const base = options.edgeBaseUrl.replace(/\/+$/, "");
  const requests: FakeEdgeUploadRequest[] = [];
  const abortedUploadIds: string[] = [];
  const parts = new Map<number, Uint8Array>();
  const failureStatuses = new Map<number, number[]>(
    Object.entries(options.partFailureStatuses ?? {}).map(([key, value]) => [Number(key), [...value]])
  );
  const uploadId = "edge-upload-1";
  let completed: Uint8Array | null = null;

  const record = async (request: Request): Promise<{ bytes: Uint8Array; authorized: boolean }> => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const authorization = request.headers.get("authorization");
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      authorization,
      contentType: request.headers.get("content-type"),
      bodyBytes: bytes.byteLength
    });
    return { bytes, authorized: authorization === `Bearer ${options.uploadToken}` };
  };

  const handlers: HttpHandler[] = [
    http.post(`${base}/v1/uploads/start`, async ({ request }) => {
      const { authorized } = await record(request);
      if (!authorized) return edgeError(401, "invalid_token", "Upload token refused");
      return HttpResponse.json({ uploadId, partSizeBytes: options.partSizeBytes, maxBytes: options.maxBytes });
    }),
    http.put(`${base}/v1/uploads/parts/:partNumber`, async ({ request, params }) => {
      const { bytes, authorized } = await record(request);
      if (!authorized) return edgeError(401, "invalid_token", "Upload token refused");
      const partNumber = Number(params.partNumber);
      if (new URL(request.url).searchParams.get("uploadId") !== uploadId || !(partNumber >= 1)) {
        return edgeError(400, "bad_request", "Need a part number and uploadId");
      }
      if (bytes.byteLength > options.partSizeBytes) return edgeError(413, "payload_too_large", "Part is too large");
      const failures = failureStatuses.get(partNumber);
      const failure = failures?.shift();
      if (failure != null) return edgeError(failure, "internal_error", `Injected part ${partNumber} failure`);
      parts.set(partNumber, bytes);
      return HttpResponse.json({ partNumber, etag: `etag-${partNumber}` });
    }),
    http.post(`${base}/v1/uploads/complete`, async ({ request }) => {
      const { bytes, authorized } = await record(request);
      if (!authorized) return edgeError(401, "invalid_token", "Upload token refused");
      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        uploadId?: unknown;
        parts?: Array<{ partNumber: number; etag: string }>;
      };
      if (body.uploadId !== uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
        return edgeError(400, "bad_request", "Need uploadId and parts");
      }
      const chunks: Uint8Array[] = [];
      for (const part of body.parts) {
        const stored = parts.get(part.partNumber);
        if (!stored || part.etag !== `etag-${part.partNumber}`) {
          return edgeError(400, "upload_failed", `Part ${part.partNumber} is missing or has a wrong etag`);
        }
        chunks.push(stored);
      }
      const sizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      if (sizeBytes > options.maxBytes) return edgeError(413, "upload_too_large", "Upload is too large");
      completed = new Uint8Array(sizeBytes);
      let offset = 0;
      for (const chunk of chunks) {
        completed.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return HttpResponse.json({ objectKey: options.objectKey, sizeBytes, etag: "object-etag" });
    }),
    http.post(`${base}/v1/uploads/abort`, async ({ request }) => {
      const { bytes, authorized } = await record(request);
      if (!authorized) return edgeError(401, "invalid_token", "Upload token refused");
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { uploadId?: string };
      abortedUploadIds.push(String(body.uploadId));
      return HttpResponse.json({});
    })
  ];

  return { handlers, requests, completedObjectBytes: () => completed, abortedUploadIds };
}
