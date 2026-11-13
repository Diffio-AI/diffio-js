import { DiffioClient } from "../../src/Client";
import { errorBody, fakeApi } from "./helpers";

const share = {
  object: "project_share", id: "ABCDEFGHJKLMNPQRS", project_id: "proj_1", generation_id: "gen_1", file_name: "interview.mp3",
  content_type: "audio/mpeg", created_at: "2026-11-13T00:35:00Z", has_video: false, duration_seconds: 31.9, preview_seconds: 8,
  base_url: "https://m.test/m/t/", files: { hls_master: "https://m.test/m/t/hls/master.m3u8" }
};

describe("models", () => {
  test("list needs no API key", async () => {
    const api = fakeApi();
    const saved = process.env.DIFFIO_API_KEY;
    delete process.env.DIFFIO_API_KEY;
    try {
      api.on("get", "/models", {
        body: { object: "list", data: [{ id: "diffio-flash", object: "model", status: "alias", label: "Diffio 4.7 Flash", served_by: "diffio-4.7-flash", price_per_hour_usd: 5 }], next_cursor: null }
      });
      const page = await new DiffioClient({ baseUrl: api.host }).models.list();
      expect(page.data[0]).toMatchObject({ id: "diffio-flash", served_by: "diffio-4.7-flash" });
      expect(page.next_cursor).toBeNull();
      expect(api.requests[0].headers.get("authorization")).toBeNull();
    } finally {
      if (saved !== undefined) process.env.DIFFIO_API_KEY = saved;
    }
  });
});

describe("shares", () => {
  test("publish, get, revoke and getPublic", async () => {
    const api = fakeApi();
    api.on("put", "/projects/:id/share", { body: share });
    api.on("get", "/projects/:id/share", { body: share });
    api.on("delete", "/projects/:id/share", { body: { object: "project_share", id: share.id, project_id: "proj_1", deleted: true } });
    api.on("get", "/shares/:id", { body: share });
    const client = api.client({ endUser: "customer-1" });
    expect((await client.shares.publish("proj_1", { preview_seconds: 5 })).id).toBe(share.id);
    expect((await client.shares.get("proj_1")).base_url).toBe(share.base_url);
    expect((await client.shares.revoke("proj_1")).deleted).toBe(true);
    expect((await client.shares.getPublic(share.id)).files.hls_master).toContain("master.m3u8");
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /projects/proj_1/share", "GET /projects/proj_1/share", "DELETE /projects/proj_1/share", `GET /shares/${share.id}`
    ]);
    expect(api.requests[0].body).toEqual({ preview_seconds: 5 });
    // The public view is key-free and not scoped to an end user.
    expect(api.requests[3].headers.get("authorization")).toBeNull();
    expect(api.requests[3].headers.get("diffio-end-user")).toBeNull();
    expect(api.requests[0].headers.get("diffio-end-user")).toBe("customer-1");
  });

  test("publish with no params sends an empty object", async () => {
    const api = fakeApi();
    api.on("put", "/projects/:id/share", { body: share });
    await api.client().shares.publish("proj_1");
    expect(api.requests[0].body).toEqual({});
  });

  test("an unshared project is share_not_found", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:id/share", { status: 404, body: errorBody("share_not_found", "This project is not shared.") });
    await expect(api.client().shares.get("proj_1")).rejects.toMatchObject({ status: 404, code: "share_not_found" });
  });
});

describe("usage", () => {
  test("get passes start and end", async () => {
    const api = fakeApi();
    api.on("get", "/usage", {
      body: { object: "usage", start: "2026-11-01T00:00:00Z", end: "2026-11-13T00:00:00Z", end_user: null, generations: 3, billable_seconds: 1260, list_price_usd: 1.75, by_model: [] }
    });
    const usage = await api.client().usage.get({ start: "2026-11-01", end: "2026-11-13" });
    expect(usage.billable_seconds).toBe(1260);
    expect(api.requests[0].search).toBe("?start=2026-11-01&end=2026-11-13");
    await api.client().usage.get();
    expect(api.requests[1].search).toBe("");
  });
});

describe("webhooks", () => {
  test("portal returns the link and event types", async () => {
    const api = fakeApi();
    api.on("post", "/webhooks/portal", { body: { object: "webhook_portal", url: "https://app.svix.test/login#key", event_types: ["generation.completed"] } });
    const portal = await api.client().webhooks.portal();
    expect(portal.url).toMatch(/^https:/);
    expect(api.requests[0].path).toBe("/webhooks/portal");
  });

  test("portal without webhooks:write is permission_denied", async () => {
    const api = fakeApi();
    api.on("post", "/webhooks/portal", { status: 403, body: errorBody("permission_denied", "Permission denied. Missing webhooks:write scope.") });
    await expect(api.client().webhooks.portal()).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });
});
