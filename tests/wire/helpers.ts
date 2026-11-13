import { HttpResponse, http, type HttpHandler } from "msw";
import { DiffioClient } from "../../src/Client";
import { mockServerPool } from "../mock-server/MockServerPool";
import type { Generation, Project, ProjectUpload, ProjectWithUpload } from "../../src/api/types";

export const API_KEY = "diffio_test_key";

/** One request the fake API received. */
export interface Recorded {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | ((request: Recorded) => { status?: number; body: unknown; headers?: Record<string, string> });

/**
 * A fake v2 API on its own random host. `on(method, path, reply)` answers that route (path below /v2,
 * `:name` segments allowed); every request lands in `requests`.
 */
export function fakeApi() {
  const server = mockServerPool.createServer();
  const requests: Recorded[] = [];
  const base = `${server.baseUrl}/v2`;
  const on = (method: "get" | "post" | "put" | "delete", path: string, reply: Reply, options: { once?: boolean } = {}) => {
    const handler: HttpHandler = http[method](`${base}${path}`, async ({ request }) => {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown = text || undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const recorded: Recorded = { method: request.method, path: url.pathname.replace(/^\/v2/, ""), search: url.search, headers: request.headers, body };
      requests.push(recorded);
      const answer = typeof reply === "function" ? reply(recorded) : reply;
      return HttpResponse.json(answer.body as Record<string, unknown>, {
        status: answer.status ?? 200,
        headers: { "X-Request-Id": "req-test", ...(answer.headers ?? {}) }
      });
    }, { once: options.once ?? false });
    server.useHandlers(handler);
  };
  const client = (options: DiffioClient.Options = {}) =>
    new DiffioClient({ apiKey: API_KEY, baseUrl: server.baseUrl, retryBackoff: 0.001, ...options });
  return { server, base, host: server.baseUrl, requests, on, client };
}

export function generation(overrides: Partial<Generation> = {}): Generation {
  return {
    id: "gen_1",
    object: "generation",
    project_id: "proj_1",
    status: "complete",
    model: "diffio-4.7-flash",
    requested_model: "diffio-flash",
    substituted: false,
    price_per_hour_usd: 5,
    stage: "complete",
    stage_progress: null,
    queue: null,
    warnings: [],
    label: null,
    kind: "restore",
    source_generation_id: null,
    edit: null,
    transcript_editable: false,
    duration_seconds: 31.9,
    quality_score: 4.1,
    transcription_status: "ready",
    files_available: ["audio", "hls_master", "transcript"],
    error: null,
    stems_status: "ready",
    created_at: "2026-11-13T00:33:26Z",
    updated_at: "2026-11-13T00:33:41Z",
    ...overrides
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    object: "project",
    status: "ready",
    file_name: "interview.mp3",
    content_type: "audio/mpeg",
    size_bytes: 10,
    duration_seconds: 31.9,
    has_video: false,
    end_user: null,
    metadata: {},
    generation_count: 0,
    video_preview_status: null,
    latest_generation: null,
    share_id: null,
    created_at: "2026-11-13T00:33:21Z",
    updated_at: "2026-11-13T00:33:21Z",
    error: null,
    ...overrides
  };
}

/** Upload instructions exactly as v2 writes them (api_v2_routes.py `_api_v2_upload`). */
export function uploadInstructions(edgeBaseUrl: string, token: string): ProjectUpload {
  const edge = `${edgeBaseUrl}/v1/uploads`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    upload_session_id: "api-proj_1",
    edge_base_url: edgeBaseUrl,
    upload_token: token,
    part_size_bytes: 8,
    max_bytes: 2147483648,
    expires_at: "2026-11-14T00:33:21Z",
    requests: {
      start: { method: "POST", url: `${edge}/start`, headers: auth, body: null, returns: ["uploadId", "partSizeBytes", "maxBytes"], description: "Once, first." },
      part: {
        method: "PUT",
        url: `${edge}/parts/{part_number}?uploadId={upload_id}`,
        headers: { ...auth, "Content-Length": "{part_length}" },
        body: null,
        returns: ["partNumber", "etag"],
        description: "Once per part."
      },
      complete: {
        method: "POST",
        url: `${edge}/complete`,
        headers: { ...auth, "Content-Type": "application/json" },
        body: { uploadId: "{upload_id}", parts: [{ partNumber: "{part_number}", etag: "{etag}" }] },
        returns: ["sizeBytes", "etag"],
        description: "Once, after every part."
      },
      abort: {
        method: "POST",
        url: `${edge}/abort`,
        headers: { ...auth, "Content-Type": "application/json" },
        body: { uploadId: "{upload_id}" },
        returns: [],
        description: "Optional."
      }
    }
  };
}

export function projectWithUpload(edgeBaseUrl: string, token: string, overrides: Partial<Project> = {}): ProjectWithUpload {
  return { ...project({ status: "awaiting_upload", ...overrides }), upload: uploadInstructions(edgeBaseUrl, token) };
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, request_id: "req-err", ...(details ? { details } : {}) } };
}
