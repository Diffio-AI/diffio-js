import { DiffioClient } from "../../../src/Client";
import { DiffioApiError, DiffioTimeoutError } from "../../../src/errors";

const ids = { apiProjectId: "project", generationId: "generation" };
function setup(responses: Array<{ status?: number; body: unknown }>) {
  const fetcher = jest.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  return { client: new DiffioClient({ apiKey: "test", fetch: fetcher as typeof fetch }), fetcher };
}

test("routes Diffio 4.0 creation", async () => {
  const { client, fetcher } = setup([{ body: { ...ids, modelKey: "diffio-4.0", status: "queued" } }]);
  await client.generations.create({ apiProjectId: ids.apiProjectId, model: "diffio-4.0" });
  expect((fetcher.mock.calls as unknown[][])[0][0]).toContain("/v1/diffio-4.0-generation");
});

test("polls identical export request until ready", async () => {
  const ready = { ...ids, downloadUrl: "https://example.com/audio", downloadType: "audio" };
  const { client, fetcher } = setup([
    { status: 202, body: { status: "pending", exportId: "export", retryAfterSeconds: 0.001 } },
    { body: ready }
  ]);
  expect(await client.generations.getDownload({ ...ids, artifact: "mix", format: "flac", backgroundGain: 0.3 }))
    .toMatchObject(ready);
  const calls = fetcher.mock.calls as unknown[][];
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toEqual(calls[1][1]);
  expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({ ...ids, artifact: "mix", format: "flac", backgroundGain: 0.3 });
});

test("preserves legacy download payload", async () => {
  const { client, fetcher } = setup([{ body: { ...ids, downloadUrl: "url" } }]);
  await client.generations.getDownload(ids);
  const calls = fetcher.mock.calls as unknown[][];
  expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual(ids);
});

test.each([NaN, Infinity, -0.1, 1.1])("rejects invalid gain %s before HTTP", async (backgroundGain) => {
  const { client, fetcher } = setup([]);
  await expect(client.generations.updateMix({ ...ids, backgroundGain, expectedRevision: 0 })).rejects.toThrow(DiffioApiError);
  await expect(client.generations.getDownload({ ...ids, backgroundGain })).rejects.toThrow(DiffioApiError);
  expect(fetcher).not.toHaveBeenCalled();
});

test("retains stale revision error and body", async () => {
  const { client } = setup([{ status: 409, body: { error: "stale revision", revision: 2 } }]);
  await expect(client.generations.updateMix({ ...ids, backgroundGain: 0.1, expectedRevision: 0 }))
    .rejects.toMatchObject({ statusCode: 409, responseBody: { revision: 2 } });
});

test("returns signed playback manifest", async () => {
  const body = { generationId: ids.generationId, manifest: { version: 1, chunks: [{ url: "signed" }] } };
  const { client } = setup([{ body }]);
  expect(await client.generations.getPlayback(ids)).toEqual(body);
});

test("aborts pending export without a second request", async () => {
  const { client, fetcher } = setup([{ status: 202, body: { status: "pending", exportId: "e", retryAfterSeconds: 2 } }]);
  const controller = new AbortController();
  const result = client.generations.getDownload({ ...ids, requestOptions: { abortSignal: controller.signal } });
  setTimeout(() => controller.abort(), 10);
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("bounds total export wait", async () => {
  const { client } = setup([{ status: 202, body: { status: "pending", exportId: "e", retryAfterSeconds: 2 } }]);
  await expect(client.generations.getDownload({ ...ids, exportTimeoutInSeconds: 0.01 })).rejects.toThrow(DiffioTimeoutError);
});

test("requests bounded playback pages and preserves manifest totals", async () => {
  const body = { generationId: ids.generationId, manifest: { startChunk: 24, chunkCount: 100,
    chunks: [{ url: "signed" }], totalSamples: 1000, availableThroughSample: 800, complete: false,
    mix: { backgroundGain: 0.2, revision: 3 } } };
  const { client, fetcher } = setup([{ body }]);
  expect(await client.generations.getPlayback({ ...ids, startChunk: 24, chunkCount: 8 })).toEqual(body);
  const calls = fetcher.mock.calls as unknown[][];
  expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({ ...ids, startChunk: 24, chunkCount: 8 });
});

test.each([
  { startChunk: -1 }, { startChunk: 1.5 }, { startChunk: NaN },
  { chunkCount: 0 }, { chunkCount: 17 }, { chunkCount: 1.5 }, { chunkCount: Infinity }
])("rejects invalid playback pagination %j", async (pagination) => {
  const { client, fetcher } = setup([]);
  await expect(client.generations.getPlayback({ ...ids, ...pagination })).rejects.toThrow(DiffioApiError);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  { exportId: "", retryAfterSeconds: 2 }, { exportId: 12, retryAfterSeconds: 2 },
  { exportId: "e", retryAfterSeconds: "2" }, { exportId: "e", retryAfterSeconds: 0 },
  { exportId: "e" }
])("rejects malformed pending export %j", async (pending) => {
  const { client, fetcher } = setup([{ status: 202, body: { status: "pending", ...pending } }]);
  await expect(client.generations.getDownload(ids)).rejects.toThrow("Invalid pending export response");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
