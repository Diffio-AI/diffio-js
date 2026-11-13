import { HttpResponse, http } from "msw";
import { DiffioClient } from "../../src/Client";
import { DiffioApiError, DiffioConnectionError, DiffioError } from "../../src/errors";
import { DIFFIO_SDK_VERSION } from "../../src/version";
import { API_KEY, errorBody, fakeApi, generation, project } from "./helpers";

describe("client transport", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("sends the key as Bearer, the SDK headers, and calls /v2 on the host", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    await api.client().projects.get("proj_1");
    const request = api.requests[0];
    expect(request.path).toBe("/projects/proj_1");
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(request.headers.get("x-diffio-sdk-language")).toBe("JavaScript");
    expect(request.headers.get("x-diffio-sdk-name")).toBe("diffio");
    expect(request.headers.get("x-diffio-sdk-version")).toBe(DIFFIO_SDK_VERSION);
    expect(request.headers.get("user-agent")).toBe(`diffio-js/${DIFFIO_SDK_VERSION}`);
    expect(request.headers.get("diffio-end-user")).toBeNull();
    expect(request.headers.get("idempotency-key")).toBeNull();
  });

  test("reads DIFFIO_API_KEY and DIFFIO_API_BASE_URL, including an old /v1 base", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    process.env.DIFFIO_API_KEY = "from-env";
    process.env.DIFFIO_API_BASE_URL = `${api.host}/v1`;
    await new DiffioClient().projects.get("proj_1");
    expect(api.requests[0].headers.get("authorization")).toBe("Bearer from-env");
    expect(await new DiffioClient().baseUrl()).toBe(`${api.host}/v2`);
  });

  test("a call without any key fails before sending", async () => {
    delete process.env.DIFFIO_API_KEY;
    const client = new DiffioClient({ baseUrl: "https://unused.example.test" });
    await expect(client.projects.get("p")).rejects.toThrow(/No API key/);
  });

  test("endUser on the client and per call becomes Diffio-End-User", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    const client = api.client({ endUser: "customer-1" });
    await client.projects.get("proj_1");
    await client.projects.get("proj_1", { endUser: "customer-2" });
    await client.projects.get("proj_1", { endUser: null });
    expect(api.requests.map((r) => r.headers.get("diffio-end-user"))).toEqual(["customer-1", "customer-2", null]);
  });

  test("a refusal becomes DiffioApiError with status, code, message, request_id and details", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/generations", {
      status: 400,
      body: errorBody("unknown_model", "nope is not a Diffio model. See GET /v2/models.", { field: "model", models: ["diffio-flash"] })
    });
    const error = await api.client().generations.create("proj_1", { model: "nope" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiffioApiError);
    expect(error).toBeInstanceOf(DiffioError);
    expect(error).toMatchObject({
      status: 400,
      code: "unknown_model",
      message: "nope is not a Diffio model. See GET /v2/models.",
      request_id: "req-err",
      details: { field: "model", models: ["diffio-flash"] }
    });
    expect(api.requests.length).toBe(1);
  });

  test("retries idempotent calls on 503 and honours Retry-After", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    api.on("get", "/projects/:id", { status: 503, body: errorBody("unavailable", "busy"), headers: { "Retry-After": "0" } }, { once: true });
    const result = await api.client().projects.get("proj_1");
    expect(result.id).toBe("proj_1");
    expect(api.requests.length).toBe(2);
  });

  test("gives up after maxRetries with the last refusal", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { status: 500, body: errorBody("internal_error", "Diffio could not complete the request.") });
    await expect(api.client({ maxRetries: 1 }).projects.get("proj_1")).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(api.requests.length).toBe(2);
  });

  test("does not retry a call that is unsafe to repeat", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/transcript/assistant/turns", { status: 503, body: errorBody("assistant_unavailable", "later") });
    await expect(api.client().assistant.createTurn("p", "g", { messages: [{ role: "user", content: "hi" }] }))
      .rejects.toMatchObject({ code: "assistant_unavailable" });
    expect(api.requests.length).toBe(1);
  });

  test("creates send one Idempotency-Key, the same on every retry; a caller key is used as given", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:id/generations", { status: 201, body: generation({ status: "queued" }) });
    api.on("post", "/projects/:id/generations", { status: 502, body: errorBody("internal_error", "x") }, { once: true });
    await api.client().generations.create("proj_1", { model: "diffio-flash" });
    const keys = api.requests.map((r) => r.headers.get("idempotency-key"));
    expect(keys.length).toBe(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);

    await api.client().generations.create("proj_1", { model: "diffio-flash" }, { idempotencyKey: "order-1042" });
    expect(api.requests.at(-1)?.headers.get("idempotency-key")).toBe("order-1042");
  });

  test("network failures are retried, then reported as DiffioConnectionError", async () => {
    const api = fakeApi();
    api.server.useHandlers(http.get(`${api.base}/projects/:id`, () => HttpResponse.error()));
    await expect(api.client({ maxRetries: 1 }).projects.get("proj_1")).rejects.toBeInstanceOf(DiffioConnectionError);

    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    api.on("get", "/models", { body: { object: "list", data: [], next_cursor: null } });
    await api.client({ fetch: flaky }).models.list();
    expect(calls).toBe(2);
  });

  test("a timeout per call aborts the attempt", async () => {
    const api = fakeApi();
    api.server.useHandlers(http.get(`${api.base}/projects/:id`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return HttpResponse.json(project());
    }));
    await expect(api.client().projects.get("proj_1", { timeout: 0.05, maxRetries: 0 })).rejects.toMatchObject({ name: "DiffioTimeoutError" });
  });

  test("custom headers and a per-call API key", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id", { body: project() });
    await api.client({ headers: { "X-Trace": "a" } }).projects.get("proj_1", { apiKey: "other", headers: { "X-Call": "b" } });
    const headers = api.requests[0].headers;
    expect(headers.get("x-trace")).toBe("a");
    expect(headers.get("x-call")).toBe("b");
    expect(headers.get("authorization")).toBe("Bearer other");
  });
});
