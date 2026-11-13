import { resolveApiBaseUrl, queryString, segment } from "../../../src/core/url";
import { apiErrorFromResponse, randomId } from "../../../src/core/transport";
import { Page, PagePromise } from "../../../src/core/pagination";
import { pollUntil } from "../../../src/core/poll";
import { retryDelayMs } from "../../../src/core/retry";
import { DiffioApiError, DiffioResourceFailedError, DiffioTimeoutError } from "../../../src/errors";

describe("base URL", () => {
  test("adds /v2 to a host and keeps an explicit /v2", () => {
    expect(resolveApiBaseUrl("https://api.diffio.ai")).toBe("https://api.diffio.ai/v2");
    expect(resolveApiBaseUrl("https://api.diffio.ai/")).toBe("https://api.diffio.ai/v2");
    expect(resolveApiBaseUrl("https://diffio-api-dev.web.app/v2/")).toBe("https://diffio-api-dev.web.app/v2");
  });

  test("moves the old SDK's /v1 base to /v2", () => {
    expect(resolveApiBaseUrl("https://api.diffio.ai/v1")).toBe("https://api.diffio.ai/v2");
  });

  test("query strings skip undefined and null; segments are encoded and required", () => {
    expect(queryString({ limit: 5, cursor: undefined, x: null })).toBe("?limit=5");
    expect(queryString({})).toBe("");
    expect(segment("a/b", "id")).toBe("a%2Fb");
    expect(() => segment("", "projectId")).toThrow("projectId is required");
  });
});

describe("apiErrorFromResponse", () => {
  test("reads the v2 error shape", () => {
    const error = apiErrorFromResponse(
      400,
      { error: { code: "unknown_model", message: "nope is not a Diffio model.", request_id: "r1", details: { field: "model" } } },
      new Headers({ "x-request-id": "other" })
    );
    expect(error).toBeInstanceOf(DiffioApiError);
    expect(error).toMatchObject({ status: 400, code: "unknown_model", message: "nope is not a Diffio model.", request_id: "r1", details: { field: "model" } });
  });

  test("codes a body without a code by status and takes the request id from the header", () => {
    const error = apiErrorFromResponse(503, "<html>busy</html>", new Headers({ "x-request-id": "hdr" }));
    expect(error).toMatchObject({ status: 503, code: "unavailable", request_id: "hdr", details: {} });
    expect(apiErrorFromResponse(418, null, null).code).toBe("invalid_request");
  });
});

describe("misc", () => {
  test("randomId is a v4 UUID", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("retry delays honour Retry-After and cap", () => {
    expect(retryDelayMs(1, 0.5, "3")).toBe(3000);
    expect(retryDelayMs(1, 0.5, "999")).toBe(60000);
    expect(retryDelayMs(10, 0.5)).toBeGreaterThanOrEqual(8000);
    expect(retryDelayMs(10, 0.5)).toBeLessThanOrEqual(10000);
  });
});

describe("pagination", () => {
  const pages: Record<string, { data: number[]; next_cursor: string | null }> = {
    start: { data: [1, 2], next_cursor: "c2" },
    c2: { data: [3], next_cursor: "c3" },
    c3: { data: [], next_cursor: null }
  };
  const load = (cursor = "start"): PagePromise<number> =>
    PagePromise.from(async () => new Page({ object: "list", ...pages[cursor] }, async (next) => load(next)));

  test("await gives one page with the wire fields", async () => {
    const page = await load();
    expect(page.data).toEqual([1, 2]);
    expect(page.next_cursor).toBe("c2");
    expect(page.hasNextPage()).toBe(true);
    expect(JSON.parse(JSON.stringify(page))).toEqual({ object: "list", data: [1, 2], next_cursor: "c2" });
    expect((await page.getNextPage())?.data).toEqual([3]);
  });

  test("for await walks every item of every page", async () => {
    const items: number[] = [];
    for await (const item of load()) items.push(item);
    expect(items).toEqual([1, 2, 3]);
    const fromPage: number[] = [];
    for await (const item of await load("c2")) fromPage.push(item);
    expect(fromPage).toEqual([3]);
  });
});

describe("pollUntil", () => {
  test("returns once done and reports every state", async () => {
    const states = ["queued", "processing", "complete"];
    const seen: string[] = [];
    const result = await pollUntil(
      async () => ({ status: states.shift() as string }),
      (r) => r.status === "complete",
      "generation",
      { pollInterval: 0, defaultTimeout: 5, onProgress: (r) => { seen.push(r.status); } }
    );
    expect(result.status).toBe("complete");
    expect(seen).toEqual(["queued", "processing", "complete"]);
  });

  test("a failed resource throws with its error code", async () => {
    await expect(pollUntil(
      async () => ({ status: "failed", error: { code: "no_speech_detected", message: "No speech." } }),
      () => false,
      "generation",
      { pollInterval: 0, defaultTimeout: 5 }
    )).rejects.toMatchObject({ name: "DiffioResourceFailedError", code: "no_speech_detected", message: "No speech." });
    expect(new DiffioResourceFailedError("x", "y", null)).toBeInstanceOf(Error);
  });

  test("times out with the last state", async () => {
    const error = await pollUntil(async () => ({ status: "queued" }), () => false, "generation", { pollInterval: 0.01, timeout: 0.03, defaultTimeout: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiffioTimeoutError);
    expect((error as DiffioTimeoutError).resource).toEqual({ status: "queued" });
  });
});
