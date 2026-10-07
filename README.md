# Diffio JS SDK

The Diffio JS SDK helps you call the Diffio API from Node. This version covers project creation, edge upload, Diffio 4.5 generations, progress checks, and download URLs.

## Install

```bash
npm install diffio
```

For local development:

```bash
cd diffio-js
npm install
```

## Configuration

Set the API key with `DIFFIO_API_KEY`. If you need to set the base URL explicitly, use the production endpoint with `DIFFIO_API_BASE_URL`.

```bash
export DIFFIO_API_KEY="diffio_live_..."
export DIFFIO_API_BASE_URL="https://api.diffio.ai/v1"
```

## Request options

Use request options to override headers, timeouts, retries, or the API key per request.

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const projects = await client.listProjects({
  requestOptions: {
    headers: { "X-Debug": "1" },
    timeoutInSeconds: 30,
    maxRetries: 2,
    retryBackoff: 0.5
  }
});
```

## Models

| Model | `model` value | Endpoint | Notes |
|---|---|---|---|
| Diffio 4.5 Flash | `diffio-4.5-flash` | `/v1/diffio-4.5-flash-generation` | Default. Fast, high quality speech restoration. |
| Diffio 4.5 Pro | `diffio-4.5-pro` | `/v1/diffio-4.5-pro-generation` | Best quality. Paid accounts only. |

Omitting `model` uses `diffio-4.5-flash`. Earlier models (`diffio-2`, `diffio-2-flash`, `diffio-3.2`,
`diffio-3.4`, `diffio-3.5`, `diffio-4.0-flash`, `diffio-4.0-pro`) are retired: the SDK refuses them
before sending a request, and the API answers their endpoints with HTTP 410 `model_retired`.
Generations created before a model was retired keep their original `modelKey`, so response
`modelKey` fields are typed as `string`.

## Create a project and generation

`createProject` creates the project, uploads the file through Diffio's upload edge, and confirms
the upload, so the project is ready for a generation when it returns.

The upload follows the session `create_project` returns: the SDK starts a multipart upload at
`{edgeBaseUrl}/v1/uploads/start`, sends the file in parts of `partSizeBytes` (32 MiB, three at a time)
to `/v1/uploads/parts/{partNumber}`, completes it with `/v1/uploads/complete`, and then calls
`/v1/complete_project_upload`. Each part is tried up to four times on network errors, timeouts,
`408`, `429`, and `5xx` answers. A failed upload is aborted and raises `DiffioUploadError` (a
`DiffioApiError`) with `uploadErrorCode` (`upload/too-large`, `upload/unauthorized`,
`upload/rejected`, `upload/network`, `upload/server`, `upload/invalid-response`, or
`upload/canceled`), the edge's `edgeErrorCode` when it sent one, and the `apiProjectId`. Files
larger than the session's `maxBytes` (2 GiB) are refused before any bytes are sent. The upload token
is used only inside the SDK and is not part of the returned project.

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const filePath = "sample.wav";

const project = await client.createProject({
  filePath
});

const generation = await client.createGeneration({
  apiProjectId: project.apiProjectId,
  model: "diffio-4.5-flash",
  idempotencyKey: "restore-sample-001"
});

console.log(generation.generationId, generation.idempotentReplay ?? false);
console.log(project.upload.objectKey, project.uploadCompletion.sizeBytes);
```

If `createProject` uploaded the file but the confirmation call failed, confirm it yourself. The call
is idempotent, and Diffio also records the upload on its own shortly after the edge completes it.

```ts
await client.projects.completeUpload({ apiProjectId: "proj_123" });
```

Reuse the same `idempotencyKey` when retrying generation creation for a project. The API then
returns the existing generation with `idempotentReplay: true` instead of creating another generation.

Generation creation automatically retries only when you supply a nonblank `idempotencyKey`, reusing
the same key and request body for every attempt. Without a key, generation creation is attempted
once, including on network errors, even if client or request options enable retries. Other requests
retain their configured retry policy. Reuse your original key and request body when manually
retrying after an uncertain response.

`waitForGeneration` and `generations.waitForComplete` wait for the overall `status` to become
`complete`. Individual stages reaching 100% or `complete` do not end polling while video publication
or usage settlement is still pending. They poll for up to 600 seconds unless you pass `timeout`
or `timeoutInSeconds`. `complete` means restored media is ready. Diffio 4.5 transcribes the recording before
restoration starts, so a completed generation has its transcript unless transcription finished as
`unavailable`; while a generation runs, transcription can be `pending`, `available`, or `unavailable`. Read
`progress.transcription?.status` independently. Older responses omit `transcription`; absence does
not establish availability. Unavailable transcription does not fail completed media.

## Audio isolation helper

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const result = await client.audioIsolation.isolate({
  filePath: "sample.wav",
  model: "diffio-4.5-flash",
  idempotencyKey: "restore-sample-001"
});

console.log(result.generation.generationId);
```

The isolation helpers create a new project before creating its generation. Their `idempotencyKey`
protects retries of that generation request; it does not deduplicate a separate helper call or upload.

## Restore audio in one call

This helper runs the full flow and returns the downloaded bytes plus a metadata object.

```ts
import fs from "node:fs";
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const [audioBytes, info] = await client.restoreAudio({
  filePath: "sample.wav",
  model: "diffio-4.5-flash",
  idempotencyKey: "restore-sample-001",
  onProgress: (progress) => console.log(progress.status)
});

if (info.error) {
  console.log(info.error);
} else if (audioBytes) {
  fs.writeFileSync("restored.mp3", Buffer.from(audioBytes));
}

console.log(info.apiProjectId, info.generationId);
```

## Generation progress

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const progress = await client.generations.getProgress({
  generationId: "gen_123",
  apiProjectId: "proj_123"
});

console.log(progress.status, progress.stage);
console.log(progress.queue?.message ?? "not queued");
console.log(progress.stageProgress?.overallPercent);
console.log(progress.transcription?.status ?? "not reported");
```

`stage` names the one step the generation is in (`pending`, `preparing`, `transcribing`, `queued`,
`starting`, `downloading`, `decoding`, `restoring`, `finalizing`, `uploading`, `complete`, or
`failed`). While it waits for a processing worker, `queue` reports its position and why it waits;
while a worker runs it, `stageProgress` reports percentages and byte counts when known.

## Generation download

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const download = await client.generations.getDownload({
  generationId: "gen_123",
  apiProjectId: "proj_123",
  downloadType: "audio"
});

console.log(download.downloadUrl);
```

`downloadUrl` is a signed, time-limited media URL that needs no `Authorization` header. The
response has `generationId`, `apiProjectId`, `downloadType`, `downloadUrl`, `fileName`,
`storagePath`, and `mimeType`.

Set `downloadType` to `"transcript"` to fetch the transcript JSON artifact when available.
Pending transcripts raise `DiffioApiError` with `statusCode === 409` and error code
`TRANSCRIPT_PENDING`. Unavailable transcripts return `404` with `TRANSCRIPT_UNAVAILABLE`.
The `responseBody` also includes `transcription.status`. Check the error code to distinguish
these from other 409 or 404 errors.

```ts
import { DiffioApiError } from "diffio";

try {
  const transcript = await client.generations.getDownload({
    generationId: "gen_123",
    apiProjectId: "proj_123",
    downloadType: "transcript"
  });
  console.log(transcript.downloadUrl);
} catch (error) {
  if (!(error instanceof DiffioApiError)) throw error;
  const body = error.responseBody;
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  if (error.statusCode === 409 && code === "TRANSCRIPT_PENDING") {
    console.log("Transcript pending; check progress and retry later.");
  } else if (error.statusCode === 404 && code === "TRANSCRIPT_UNAVAILABLE") {
    console.log("Transcript unavailable; restored media remains available.");
  } else {
    throw error;
  }
}
```

`restoreAudio` with `downloadType: "transcript"` also attempts a transcript download after
media completion. It does not wait for pending transcription. With the default `raiseOnError: false`,
it returns `[null, info]` and preserves `info.statusCode` and `info.responseBody`; `info.status`
can still be `complete` because media restoration succeeded. With `raiseOnError: true`, it throws
`DiffioApiError` and attaches metadata as `error.restoreInfo`. Poll progress and retry the download
explicitly for the same generation. Audio and video downloads proceed independently of transcription.

## Account, keys, usage, and webhook configuration

Agent keys can manage account settings, scoped keys, usage, and webhook endpoints.

```ts
const settings = await client.account.getSettings();
const key = await client.apiKeys.create({
  label: "Backend worker",
  scopes: ["projects:read", "projects:write", "generations:read", "generations:write", "artifacts:read"]
});
const usage = await client.usage.summary({ apiKeyId: key.keyId });
const webhook = await client.webhooks.configure({
  mode: "live",
  url: "https://example.com/webhooks/diffio",
  eventTypes: ["generation.completed", "generation.failed"],
  apiKeyId: key.keyId
});
```

## List projects

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const projects = await client.projects.list();

for (const project of projects.projects) {
  console.log(project.apiProjectId, project.status);
}
```

## List project generations

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const generations = await client.projects.listGenerations({ apiProjectId: "proj_123" });

for (const generation of generations.generations) {
  console.log(generation.generationId, generation.status);
}
```

## Send a test webhook event

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const event = await client.webhooks.sendTestEvent({
  eventType: "generation.completed",
  mode: "live",
  samplePayload: { apiProjectId: "proj_123" }
});

console.log(event.svixMessageId);
```

## Verify webhook signatures

Use the raw request body (not parsed JSON) plus the `svix-*` headers and your webhook signing secret.

Verified events expose the same optional `event.transcription` object as generation progress.
A `generation.completed` event reports `available` transcription, or `unavailable` when no
transcript could be produced; completion does not wait for a later transcript. Older events can omit
`transcription`.

```ts
import express from "express";
import { DiffioClient } from "diffio";

const app = express();
const client = new DiffioClient({ apiKey: process.env.DIFFIO_API_KEY });

app.post("/webhooks/diffio", express.raw({ type: "application/json" }), (req, res) => {
  const payload = req.body;
  const headers = {
    "svix-id": req.header("svix-id"),
    "svix-timestamp": req.header("svix-timestamp"),
    "svix-signature": req.header("svix-signature")
  };

  try {
    const event = client.webhooks.verifySignature({
      payload,
      headers,
      secret: process.env.DIFFIO_WEBHOOK_SECRET
    });
    console.log("Webhook received", event.eventType);
    res.status(200).send("ok");
  } catch (err) {
    res.status(400).send("Invalid signature");
  }
});
```

## Runtime compatibility

Use Node 18 or later so `fetch` is available without extra packages.
Examples use ES modules. Save files with a `.mjs` extension or set `"type": "module"` in your package.json.

## Tests

```bash
cd diffio-js
npm run build
npm test
```
