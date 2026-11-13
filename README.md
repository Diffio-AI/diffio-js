# Diffio JS SDK

The official JavaScript and TypeScript client for [Diffio API v2](https://diffio.ai/docs) (`https://api.diffio.ai/v2`).
It restores speech in audio and video: upload a file, start a restore, wait, and download the result.

- One call for the whole job: `client.restoreAudio(...)`.
- Every v2 route as a typed method, with request and response fields in snake_case exactly as on the wire.
- Uploads straight to Diffio's media host in parts, retrying each part.
- Typed errors, automatic retries, `for await` pagination, end-user scoping, idempotency keys and webhook
  signature checks.
- Node 18+ (file paths, Blob, Buffer) and browsers (Blob, File).

Version 1.0.0 talks to v2 only. Code written for the 0.x SDK (v1 endpoints) keeps working on `diffio@0.4`.

## Install

```bash
npm install diffio
```

## Authenticate

Create an API key on the developer dashboard (`/developers/api-keys`) with the Write permission, then either set
`DIFFIO_API_KEY` or pass it:

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: process.env.DIFFIO_API_KEY });
```

The key is sent as `Authorization: Bearer <key>`. Keep it on your server: in a browser, call your own backend.

## Restore a file in one call

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient(); // reads DIFFIO_API_KEY

const result = await client.restoreAudio({
  file: "interview.mp3",
  model: "diffio-flash",
  outputPath: "interview.restored.mp3",
});

console.log(result.generation.status, result.generation.model, result.output_path, result.size_bytes);
```

`restoreAudio` creates a project with a generation, uploads the file, waits for the restore and downloads the
restored audio. `file` can be a path (Node), a `Blob` or `File`, or bytes (then pass `file_name`). Without
`outputPath` the bytes come back in `result.data`. Other options: `metadata`, `label`, `sampling`, `content_type`,
`downloadFile` (default `"audio"`; `"video"` for a restored video), `timeout` (seconds to wait, default 3600),
`pollInterval` (seconds, default 2), `onProgress`, `onUploadProgress`, `endUser`, `idempotencyKey`, `signal`.

## Step by step

```ts
import fs from "node:fs";
import { DiffioClient } from "diffio";

const client = new DiffioClient();

// 1) Create the project: the answer carries upload instructions.
const project = await client.projects.create({
  file_name: "interview.mp3",
  content_type: "audio/mpeg",
  size_bytes: fs.statSync("interview.mp3").size,
  metadata: { order_id: "1042" },
});

// 2) Upload the bytes (parts, retries) and mark the upload complete.
await client.projects.upload(project, "interview.mp3");

// 3) Start a restore.
const generation = await client.generations.create(project.id, { model: "diffio-flash" });

// 4) Wait for it to finish.
const done = await client.generations.wait(project.id, generation.id, {
  onProgress: (g) => console.log(g.status, g.stage, g.stage_progress?.overall_percent ?? ""),
});

// 5) Download the restored audio.
const file = await client.generations.download(project.id, done.id, {
  file: "audio",
  path: "interview.restored.mp3",
});
```

- `projects.create` accepts `generation: { model }` to request the first restore at once; it starts by itself when
  the upload is ready (`project.latest_generation` is that generation).
- `projects.upload(project, file)` follows `project.upload.requests` (start, parts of `part_size_bytes`, complete),
  retries failed parts up to four times, then calls `projects.completeUpload` so the file is checked now (pass
  `complete: false` to skip; the project then becomes ready by itself about 30 s later). Give it a project id instead
  of the object and it fetches fresh instructions with `projects.reopenUpload`. Upload tokens last 24 hours.
- `generations.media(projectId, generationId)` returns URLs for every file (`audio`, `video`, `hls_master`,
  `transcript`, `original`, ...). They need no API key and expire after 6 hours; `download` fetches one of them.

## Models

`GET /v2/models` lists every name and needs no key:

```ts
const models = await client.models.list();
```

Use `diffio-flash` (Diffio 4.7 Flash, $5 per hour) or `diffio-pro` (Diffio 4.7 Pro, $10 per hour); these tier names
always mean the current model. `diffio-4.7-flash` and `diffio-4.7-pro` name the model exactly. Retired names still run
on the current model of their tier; the generation then says `substituted: true` and `requested_model`.

## Lists and pagination

```ts
// One page: data and next_cursor exactly as the API sends them.
const page = await client.projects.list({ limit: 1 });
console.log("first page:", page.data.map((p) => p.id), "next_cursor:", page.next_cursor);

// Every project, newest first; the SDK fetches the next page when it needs it.
for await (const project of client.projects.list({ limit: 1 })) {
  console.log(project.id, project.status, project.file_name, project.latest_generation?.status);
}
```

`generations.list(projectId, { limit, cursor })` works the same way. A page also has `hasNextPage()`,
`getNextPage()` and `iterPages()`.

## Request options

Every method takes an options object last:

```ts
await client.generations.create(
  project.id,
  { model: "diffio-pro" },
  { endUser: "customer-42", idempotencyKey: "order-1042-restore", timeout: 30, maxRetries: 4 },
);
```

| Option | What it does |
|---|---|
| `endUser` | Sent as `Diffio-End-User`: the request acts for one end user of your product and only reaches that end user's projects. Also settable on the client (`new DiffioClient({ endUser })`). `projects.create` also accepts `end_user` in its params and sends it as this header. |
| `idempotencyKey` | Sent as `Idempotency-Key` on `projects.create`, `generations.create` and `edits.create`. Repeating a call with the same key returns the same resource; reusing it for a different request is refused (409 `idempotency_key_conflict`). When you leave it out the SDK makes one per call, so its own retries never create twice. |
| `timeout` | Seconds before one HTTP attempt gives up (client default 60). |
| `maxRetries` | Retries after network errors, 408, 429 and 5xx (client default 2). Only calls that are safe to repeat are retried. |
| `signal` | An `AbortSignal` to cancel. |
| `headers`, `apiKey` | Extra headers or another key for this call. |

Client options: `apiKey`, `baseUrl` (a host such as `https://diffio-api-dev.web.app`; `/v2` is added), `endUser`,
`timeout`, `maxRetries`, `retryBackoff`, `retryStatusCodes`, `headers`, `fetch`. `DIFFIO_API_BASE_URL` overrides the
host when `baseUrl` is not passed.

## Errors

```ts
import { DiffioApiError } from "diffio";

try {
  await client.generations.create(project.id, { model: "nope" });
} catch (error) {
  if (error instanceof DiffioApiError) {
    console.log(error.status, error.code, error.message, error.request_id, error.details);
    // 400 unknown_model "nope is not a Diffio model. See GET /v2/models." "f064..." { field: "model", models: [...] }
  }
}
```

| Class | When |
|---|---|
| `DiffioApiError` | The API refused the request. `status`, `code` (stable snake_case), `message`, `request_id` (quote it to support), `details`. |
| `DiffioUploadError` | The media host refused or lost an upload. Extends `DiffioApiError`; adds `retryable` and `project_id`. |
| `DiffioResourceFailedError` | A `wait` helper saw the generation, export or assistant turn fail. `code` and `message` come from its `error`; `resource` is the failed object. |
| `DiffioTimeoutError` | A request or a `wait` ran out of time (`resource` holds the last state read). |
| `DiffioConnectionError` | No HTTP answer after every retry. |
| `DiffioWebhookVerificationError` | A webhook delivery did not verify. |

All extend `DiffioError`.

## Editing, mixes, exports, transcripts and shares

```ts
const transcript = await client.transcripts.get(project.id, done.id);

// Separated tracks: save a mix, then render it as a file.
await client.mix.save(project.id, done.id, { background_gain: 0.2, leveling: true });
const exported = await client.exports.create(project.id, done.id, { artifact: "mix", format: "mp3" });
const ready = await client.exports.wait(project.id, done.id, exported.id);
console.log(ready.url);

// Re-say words of a finished Pro result (bills only the windows it restores).
const estimate = await client.edits.estimate(project.id, done.id, { words });
const edit = await client.edits.create(project.id, done.id, { words });
await client.generations.wait(project.id, edit.id);

// A public, key-free view of the result.
const share = await client.shares.publish(project.id, { preview_seconds: 30 });
const view = await client.shares.getPublic(share.id);
```

## Webhooks

Open the webhook portal with `await client.webhooks.portal()` (the key needs the `webhooks:write` scope), add your
endpoint there and copy its signing secret (`whsec_...`). Then check every delivery before trusting it:

```ts
import http from "node:http";
import { DiffioClient, DiffioWebhookVerificationError } from "diffio";

const client = new DiffioClient();
const secret = process.env.DIFFIO_WEBHOOK_SECRET; // whsec_... from the webhook portal

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        // Pass the raw body exactly as received.
        const event = client.webhooks.verifySignature(Buffer.concat(chunks), req.headers, secret);
        console.log("verified", event.type, event.id, event.data.id);
        res.writeHead(204).end();
      } catch (error) {
        if (!(error instanceof DiffioWebhookVerificationError)) throw error;
        console.log("rejected", error.message);
        res.writeHead(400).end();
      }
    });
  })
  .listen(Number(process.env.PORT ?? 3000));
```

`verifySignature(payload, headers, secret)` checks `svix-id`, `svix-timestamp` (within 5 minutes) and
`svix-signature` with Node's crypto and returns the event `{ type, id, created_at, data }`. On Cloudflare Workers,
Deno, Bun or in a browser use `await client.webhooks.verifySignatureAsync(...)` (WebCrypto). Both are also exported as
`verifyWebhookSignature` and `verifyWebhookSignatureAsync`, so a webhook server needs no API key. De-duplicate on
`event.id`: retries carry the same id.

## Browsers

The SDK runs in browsers with `fetch`: pass a `File` or `Blob` to `projects.upload` or `restoreAudio`. File paths and
`download({ path })` are Node only. Do not ship your API key to browsers; create the project on your server and hand
the browser only what it needs.

## Method reference

| Method | Route |
|---|---|
| `models.list()` | `GET /v2/models` |
| `projects.create(params)` | `POST /v2/projects` |
| `projects.upload(project, file, options?)` | media host `upload.requests`, then `POST .../upload/complete` |
| `projects.reopenUpload(projectId)` | `POST /v2/projects/{id}/upload` |
| `projects.completeUpload(projectId)` | `POST /v2/projects/{id}/upload/complete` |
| `projects.list(params?)` | `GET /v2/projects` |
| `projects.get(projectId)` | `GET /v2/projects/{id}` |
| `projects.delete(projectId)` | `DELETE /v2/projects/{id}` |
| `generations.create(projectId, params)` | `POST .../generations` |
| `generations.list(projectId, params?)` | `GET .../generations` |
| `generations.get(projectId, generationId)` | `GET .../generations/{gid}` |
| `generations.wait(projectId, generationId, options?)` | polls `get` |
| `generations.media(projectId, generationId, params?)` | `GET .../generations/{gid}/media` |
| `generations.download(projectId, generationId, options?)` | `media`, then the file URL |
| `edits.estimate(...)`, `edits.create(...)` | `POST .../edits/estimate`, `POST .../edits` |
| `mix.get(...)`, `mix.save(...)` | `GET`/`PUT .../mix` |
| `exports.create(...)`, `exports.get(...)`, `exports.wait(...)` | `POST .../exports`, `GET .../exports/{eid}` |
| `transcripts.get(...)` | `GET .../transcript` |
| `transcripts.getDraft/saveDraft/deleteDraft(...)` | `GET`/`PUT`/`DELETE .../transcript/draft` |
| `assistant.createTurn/getTurn/waitTurn(...)` | `POST`/`GET .../transcript/assistant/turns` |
| `shares.publish/get/revoke(projectId)` | `PUT`/`GET`/`DELETE /v2/projects/{id}/share` |
| `shares.getPublic(shareId)` | `GET /v2/shares/{share_id}` |
| `usage.get(params?)` | `GET /v2/usage` |
| `webhooks.portal()` | `POST /v2/webhooks/portal` |
| `webhooks.verifySignature(payload, headers, secret)` | local check |
| `restoreAudio(params)` | create, upload, wait, download |

## Upgrading from 0.x

1.0.0 removes every v1 method (`createProject`, `createGeneration`, `getGenerationProgress`, `waitForGeneration`,
`getGenerationDownload`, `audioIsolation`, `apiKeys`, `account`, `getUsageSummary`, `configureWebhook`,
`sendWebhookTestEvent`). Responses are v2 objects with snake_case fields (`project.id`, not `apiProjectId`). API keys,
account settings and webhook endpoints are managed on the dashboard and in the webhook portal. A base URL ending in
`/v1` is moved to `/v2`.

## Development

```bash
npm install
npm run build
npm test            # unit + wire (MSW)
npm run test:unit
npm run test:wire
```
