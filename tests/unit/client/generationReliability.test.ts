import { DiffioClient } from "../../../src/Client";
import { DiffioApiError } from "../../../src/errors";

describe("generation reliability", () => {
  const generationResponse = {
    generationId: "gen_123",
    apiProjectId: "proj_123",
    modelKey: "diffio-2",
    status: "queued"
  };

  test.each([undefined, "", "   "])(
    "does not retry server failures without a usable key (%p)",
    async (idempotencyKey) => {
      const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
      const client = new DiffioClient({ apiKey: "test", fetch: fetchMock, maxRetries: 3, retryBackoff: 0 });
      await expect(client.createGeneration({
        apiProjectId: "proj_123",
        idempotencyKey,
        requestOptions: { maxRetries: 4 }
      })).rejects.toThrow(DiffioApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  test("does not retry uncertain transport failures without a key", async () => {
    const failure = new TypeError("response lost after acceptance");
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(failure);
    const client = new DiffioClient({ apiKey: "test", fetch: fetchMock, maxRetries: 3, retryBackoff: 0 });
    await expect(client.generations.create({
      apiProjectId: "proj_123",
      requestOptions: { maxRetries: 4 }
    })).rejects.toThrow(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reuses the exact key and body across server and transport retries", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }))
      .mockRejectedValueOnce(new TypeError("response lost after acceptance"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...generationResponse, idempotentReplay: true })));
    const client = new DiffioClient({ apiKey: "test", fetch: fetchMock, maxRetries: 2, retryBackoff: 0 });
    const response = await client.generations.create({
      apiProjectId: "proj_123",
      idempotencyKey: " caller-key ",
      sampling: { steps: 20 },
      params: { output: "wav" }
    });
    expect(response.idempotentReplay).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => init?.body);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({
      apiProjectId: "proj_123",
      idempotencyKey: " caller-key ",
      sampling: { steps: 20 },
      params: { output: "wav" }
    });
  });

  test("preserves explicit retry disabling even with a key", async () => {
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new TypeError("connection lost"));
    const client = new DiffioClient({ apiKey: "test", fetch: fetchMock, maxRetries: 3, retryBackoff: 0 });
    await expect(client.createGeneration({
      apiProjectId: "proj_123",
      idempotencyKey: "caller-key",
      requestOptions: { maxRetries: 0 }
    })).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("continues polling after stages complete until overall completion", async () => {
    const stage = { status: "complete", progress: 100 };
    const progress = {
      ...generationResponse,
      status: "processing",
      hasVideo: true,
      preProcessing: stage,
      inference: stage,
      restoredVideo: { status: "running", progress: 20 }
    };
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(progress)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...progress, restoredVideo: stage })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...progress, restoredVideo: stage, status: "complete" })));
    const onProgress = jest.fn();
    const client = new DiffioClient({ apiKey: "test", fetch: fetchMock });
    const result = await client.generations.waitForComplete({
      generationId: "gen_123",
      pollInterval: 0,
      timeoutInSeconds: 5,
      onProgress
    });
    expect(result.status).toBe("complete");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([value]) => value.status)).toEqual(["processing", "processing", "complete"]);
  });

  test("reports overall failure even when inference is complete", async () => {
    const stage = { status: "complete", progress: 100 };
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(JSON.stringify({
        ...generationResponse,
        status: "failed",
        hasVideo: true,
        preProcessing: stage,
        inference: stage,
        restoredVideo: { status: "failed", progress: 20 },
        error: "video restoration failed"
      })));
    const client = new DiffioClient({ apiKey: "test", fetch: fetchMock });
    await expect(client.waitForGeneration({ generationId: "gen_123" }))
      .rejects.toThrow("video restoration failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
