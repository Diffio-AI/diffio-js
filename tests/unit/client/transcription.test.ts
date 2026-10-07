import { Webhook } from "svix";
import { DiffioClient } from "../../../src/Client";
import type { AudioIsolationResult, GenerationProgressResponse } from "../../../src/api/types";

const completedProgress: GenerationProgressResponse = {
  generationId: "gen_transcription",
  apiProjectId: "proj_transcription",
  status: "complete",
  hasVideo: false,
  preProcessing: { status: "complete", progress: 100 },
  inference: { status: "complete", progress: 100 }
};

const isolation: AudioIsolationResult = {
  project: {
    apiProjectId: completedProgress.apiProjectId,
    upload: {
      uploadSessionId: `api-${completedProgress.apiProjectId}`,
      edgeBaseUrl: "https://media.example.com",
      objectKey: "api/users/user_1/projects/proj_transcription/original/sample.wav",
      partSizeBytes: 33554432,
      maxBytes: 2147483648,
      expiresAt: "2026-01-01T00:00:00Z"
    },
    objectPath: "api/users/user_1/projects/proj_transcription/original/sample.wav",
    expiresAt: "2026-01-01T00:00:00Z",
    uploadCompletion: { apiProjectId: completedProgress.apiProjectId, status: "uploaded", sizeBytes: 1024 }
  },
  generation: {
    generationId: completedProgress.generationId,
    apiProjectId: completedProgress.apiProjectId,
    modelKey: "diffio-4.5-flash",
    status: "queued"
  }
};

const transcriptFailures = [
  { status: "pending", statusCode: 409, code: "TRANSCRIPT_PENDING", error: "Transcript is not ready yet." },
  { status: "unavailable", statusCode: 404, code: "TRANSCRIPT_UNAVAILABLE", error: "Transcript is unavailable." }
] as const;

describe("independent transcription", () => {
  test.each(["pending", "available", "unavailable", undefined] as const)(
    "media completion succeeds with transcription %p without further polling",
    async (status) => {
      const transcription = status ? { status } : undefined;
      const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...completedProgress, transcription })));
      const client = new DiffioClient({ apiKey: "test", fetch: fetchMock });
      const onProgress = jest.fn();

      const progress = await client.generations.waitForComplete({
        generationId: completedProgress.generationId,
        pollInterval: 0,
        onProgress
      });

      expect(progress.status).toBe("complete");
      expect(progress.transcription).toEqual(transcription);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(progress);
      if (!status) {
        expect(progress).not.toHaveProperty("transcription");
      }
    }
  );

  test.each(["pending", "unavailable"] as const)(
    "restores audio with transcription %s and preserves its status in metadata",
    async (status) => {
      const audioBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          ...completedProgress,
          transcription: { status }
        })))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          generationId: completedProgress.generationId,
          apiProjectId: completedProgress.apiProjectId,
          downloadType: "audio",
          downloadUrl: "https://download.example.com/restored.mp3",
          fileName: "restored.mp3",
          storagePath: "outputs/restored.mp3",
          mimeType: "audio/mpeg"
        })))
        .mockResolvedValueOnce(new Response(audioBytes));
      const client = new DiffioClient({ apiKey: "test", fetch: fetchMock });
      jest.spyOn(client, "audioIsolationIsolate").mockResolvedValue(isolation);

      const [bytes, metadata] = await client.audioIsolation.restoreAudio({ filePath: "sample.wav" });

      expect(bytes).toEqual(audioBytes);
      expect(metadata).toMatchObject({
        ok: true,
        stage: "complete",
        status: "complete",
        progress: { transcription: { status } }
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).downloadType).toBe("audio");
    }
  );

  describe.each(transcriptFailures)("transcript $status", (failure) => {
    test.each([false, true])("preserves structured download errors with raiseOnError=%p", async (raiseOnError) => {
      const responseBody = {
        error: failure.error,
        code: failure.code,
        transcription: { status: failure.status }
      };
      const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          ...completedProgress,
          transcription: { status: failure.status }
        })))
        .mockResolvedValueOnce(new Response(JSON.stringify(responseBody), {
          status: failure.statusCode,
          headers: { "Content-Type": "application/json" }
        }));
      const client = new DiffioClient({ apiKey: "test", fetch: fetchMock, maxRetries: 3 });
      jest.spyOn(client, "audioIsolationIsolate").mockResolvedValue(isolation);
      const expectedMetadata = {
        ok: false,
        stage: "download_info",
        status: "complete",
        error: failure.error,
        statusCode: failure.statusCode,
        responseBody,
        progress: { transcription: { status: failure.status } }
      };

      const result = client.restoreAudio({ filePath: "sample.wav", downloadType: "transcript", raiseOnError });
      if (raiseOnError) {
        await expect(result).rejects.toMatchObject({
          name: "DiffioApiError",
          statusCode: failure.statusCode,
          responseBody,
          restoreInfo: expectedMetadata
        });
      } else {
        const [bytes, metadata] = await result;
        expect(bytes).toBeNull();
        expect(metadata).toMatchObject(expectedMetadata);
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  test.each(["pending", "available", "unavailable", undefined] as const)(
    "verified completion webhooks preserve transcription %p",
    (status) => {
      const client = new DiffioClient({ apiKey: "test" });
      const secret = `whsec_${Buffer.from("synthetic-webhook-signing-key").toString("base64")}`;
      const timestamp = new Date();
      const eventId = "msg_transcription";
      const transcription = status ? { status } : undefined;
      const payload = JSON.stringify({
        eventType: "generation.completed",
        eventId: "evt_transcription",
        createdAt: timestamp.toISOString(),
        apiKeyId: "key_synthetic",
        generationId: completedProgress.generationId,
        apiProjectId: completedProgress.apiProjectId,
        modelKey: "diffio-2",
        status: "complete",
        transcription
      });
      const event = client.webhooks.verifySignature({
        payload,
        secret,
        headers: {
          "svix-id": eventId,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "svix-signature": new Webhook(secret).sign(eventId, timestamp, payload)
        }
      });

      expect(event.status).toBe("complete");
      expect(event.transcription).toEqual(transcription);
      if (!status) {
        expect(event).not.toHaveProperty("transcription");
      }
    }
  );
});
