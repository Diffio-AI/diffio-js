import { errorBody, fakeApi, generation } from "./helpers";

const G = "/projects/proj_1/generations/gen_1";

describe("edits", () => {
  const words = [
    { id: "word-0", text: "Hello", start: 0.1, end: 0.4 },
    { id: "word-1", text: "there", changed: true }
  ];

  test("estimate posts the words and returns the estimate", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/edits/estimate", {
      body: { object: "transcript_edit_estimate", project_id: "proj_1", generation_id: "gen_1", edit_count: 1, max_windows: 1, window_seconds: 30, max_billable_seconds: 30 }
    });
    const estimate = await api.client().edits.estimate("proj_1", "gen_1", { words });
    expect(estimate.max_billable_seconds).toBe(30);
    expect(api.requests[0].path).toBe(`${G}/edits/estimate`);
    expect(api.requests[0].body).toEqual({ words });
    expect(api.requests[0].headers.get("idempotency-key")).toBeNull();
  });

  test("create returns the edit generation and sends Idempotency-Key", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/edits", { status: 201, body: generation({ id: "gen_2", kind: "edit", source_generation_id: "gen_1", status: "queued" }) });
    const edit = await api.client().edits.create("proj_1", "gen_1", { words, tighten: { close_removed_gaps: true }, request_id: "r-1" }, { idempotencyKey: "edit-1" });
    expect(edit).toMatchObject({ kind: "edit", source_generation_id: "gen_1" });
    expect(api.requests[0].headers.get("idempotency-key")).toBe("edit-1");
    expect(api.requests[0].body).toEqual({ words, tighten: { close_removed_gaps: true }, request_id: "r-1" });
  });

  test("not_editable comes back typed", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/edits/estimate", { status: 409, body: errorBody("not_editable", "Only Pro results can be edited.") });
    await expect(api.client().edits.estimate("proj_1", "gen_1", { words })).rejects.toMatchObject({ status: 409, code: "not_editable" });
  });
});

describe("mix", () => {
  const mix = { object: "generation_mix", project_id: "proj_1", generation_id: "gen_1", background_gain: 0.25, leveling: true, revision: "r1:2", stems_revision: "r1" };

  test("get and save", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:p/generations/:g/mix", { body: mix });
    api.on("put", "/projects/:p/generations/:g/mix", { body: { ...mix, revision: "r1:3" } });
    const client = api.client();
    expect((await client.mix.get("proj_1", "gen_1")).background_gain).toBe(0.25);
    const saved = await client.mix.save("proj_1", "gen_1", { background_gain: 0.25, leveling: true, revision: "r1:2" });
    expect(saved.revision).toBe("r1:3");
    expect(api.requests[1]).toMatchObject({ method: "PUT", path: `${G}/mix`, body: { background_gain: 0.25, leveling: true, revision: "r1:2" } });
  });

  test("a stale revision is revision_conflict with current_revision", async () => {
    const api = fakeApi();
    api.on("put", "/projects/:p/generations/:g/mix", { status: 409, body: errorBody("revision_conflict", "Stale.", { current_revision: "r1:9" }) });
    await expect(api.client().mix.save("proj_1", "gen_1", { background_gain: 0, revision: "r1:2" }))
      .rejects.toMatchObject({ code: "revision_conflict", details: { current_revision: "r1:9" } });
  });
});

describe("exports", () => {
  const exported = (status: string, url: string | null = null) => ({
    object: "generation_export", id: "0123456789abcdef0123456789abcdef", project_id: "proj_1", generation_id: "gen_1",
    status, artifact: "mix", format: "mp3", background_gain: 0.2, leveling: false, inline: false, url, error: null
  });

  test("create, get with file_name, and wait until ready", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/exports", { status: 201, body: exported("queued") });
    const states = [exported("processing"), exported("ready", "https://m.test/x.mp3?download=v2%20mix.mp3")];
    api.on("get", "/projects/:p/generations/:g/exports/:e", () => ({ body: states.shift() ?? exported("ready", "u") }));
    const client = api.client();
    const created = await client.exports.create("proj_1", "gen_1", { artifact: "mix", format: "mp3", background_gain: 0.2, file_name: "v2 mix" });
    expect(api.requests[0].body).toEqual({ artifact: "mix", format: "mp3", background_gain: 0.2, file_name: "v2 mix" });
    const ready = await client.exports.wait("proj_1", "gen_1", created.id, { pollInterval: 0, file_name: "v2 mix" });
    expect(ready.url).toContain("download=v2%20mix.mp3");
    expect(api.requests[1].path).toBe(`${G}/exports/${created.id}`);
    expect(api.requests[1].search).toBe("?file_name=v2+mix");
  });

  test("a failed export throws from wait", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:p/generations/:g/exports/:e", { body: { ...exported("failed"), error: { code: "export_failed", message: "Render failed." } } });
    await expect(api.client().exports.wait("proj_1", "gen_1", "e1", { pollInterval: 0 })).rejects.toMatchObject({ code: "export_failed" });
  });
});

describe("transcripts", () => {
  test("get with preview_seconds", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:p/generations/:g/transcript", {
      body: { object: "transcript", project_id: "proj_1", generation_id: "gen_1", text: "Hello there", words: [{ id: "word-0", text: "Hello", start: 0.1, end: 0.4, probability: 0.98 }], preview_seconds: 8, truncated: true }
    });
    const transcript = await api.client().transcripts.get("proj_1", "gen_1", { preview_seconds: 5 });
    expect(transcript.words[0].text).toBe("Hello");
    expect(api.requests[0].search).toBe("?preview_seconds=5");
  });

  test("getDraft, saveDraft and deleteDraft", async () => {
    const api = fakeApi();
    const draft = (revision: string, data: Record<string, unknown> | null) => ({ object: "transcript_draft", project_id: "proj_1", generation_id: "gen_1", revision, data, created_at: null, updated_at: null });
    api.on("get", "/projects/:p/generations/:g/transcript/draft", { body: draft("0", null) });
    api.on("put", "/projects/:p/generations/:g/transcript/draft", { body: draft("1", { words: [] }) });
    api.on("delete", "/projects/:p/generations/:g/transcript/draft", { body: { object: "transcript_draft", project_id: "proj_1", generation_id: "gen_1", deleted: true, revision: "2" } });
    const client = api.client();
    expect((await client.transcripts.getDraft("proj_1", "gen_1")).data).toBeNull();
    expect((await client.transcripts.saveDraft("proj_1", "gen_1", { data: { words: [] }, revision: "0" })).revision).toBe("1");
    expect((await client.transcripts.deleteDraft("proj_1", "gen_1", { revision: "1" })).deleted).toBe(true);
    expect(api.requests.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([
      `GET ${G}/transcript/draft`,
      `PUT ${G}/transcript/draft`,
      `DELETE ${G}/transcript/draft?revision=1`
    ]);
    expect(api.requests[1].body).toEqual({ data: { words: [] }, revision: "0" });
  });
});

describe("assistant", () => {
  const turn = (status: string, extra: Record<string, unknown> = {}) => ({
    object: "transcript_assistant_turn", id: "t".repeat(32), project_id: "proj_1", generation_id: "gen_1", status,
    created_at: "2026-11-13T00:40:00Z", completed_at: status === "processing" ? null : "2026-11-13T00:40:09Z", error: null, ...extra
  });

  test("createTurn, getTurn and waitTurn", async () => {
    const api = fakeApi();
    api.on("post", "/projects/:p/generations/:g/transcript/assistant/turns", { status: 202, body: turn("processing") });
    const states = [turn("processing"), turn("complete", { reply: "Removed two fillers.", proposals: [] })];
    api.on("get", "/projects/:p/generations/:g/transcript/assistant/turns/:t", () => ({ body: states.shift() ?? turn("complete") }));
    const client = api.client();
    const created = await client.assistant.createTurn("proj_1", "gen_1", { messages: [{ role: "user", content: "Remove the ums" }], playhead_seconds: 3 });
    expect(created.status).toBe("processing");
    expect(api.requests[0].body).toEqual({ messages: [{ role: "user", content: "Remove the ums" }], playhead_seconds: 3 });
    expect((await client.assistant.getTurn("proj_1", "gen_1", created.id)).status).toBe("processing");
    const done = await client.assistant.waitTurn("proj_1", "gen_1", created.id, { pollInterval: 0 });
    expect(done.reply).toBe("Removed two fillers.");
    expect(api.requests[1].path).toBe(`${G}/transcript/assistant/turns/${created.id}`);
  });

  test("a failed turn throws from waitTurn", async () => {
    const api = fakeApi();
    api.on("get", "/projects/:p/generations/:g/transcript/assistant/turns/:t", { body: turn("failed", { error: { code: "rate_limited", message: "Too many requests." } }) });
    await expect(api.client().assistant.waitTurn("proj_1", "gen_1", "t1", { pollInterval: 0 })).rejects.toMatchObject({ code: "rate_limited" });
  });
});
