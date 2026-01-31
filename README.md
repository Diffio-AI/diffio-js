# Diffio JS SDK

The Diffio JS SDK helps you call the Diffio API from Node. This version covers project creation, upload, generation, progress checks, and download URLs.

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

## Create a project and generation

`createProject` uploads the file and returns the project metadata.

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const filePath = "sample.wav";

const project = await client.createProject({
  filePath
});

const generation = await client.createGeneration({
  apiProjectId: project.apiProjectId,
  model: "diffio-2",
  sampling: { steps: 12, guidance: 1.5 }
});

console.log(generation.generationId);
```

## Audio isolation helper

```ts
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const result = await client.audioIsolation.isolate({
  filePath: "sample.wav",
  model: "diffio-2",
  sampling: { steps: 12, guidance: 1.5 }
});

console.log(result.generation.generationId);
```

## Restore audio in one call

This helper runs the full flow and returns the downloaded bytes plus a metadata object.

```ts
import fs from "node:fs";
import { DiffioClient } from "diffio";

const client = new DiffioClient({ apiKey: "diffio_live_..." });
const [audioBytes, info] = await client.restoreAudio({
  filePath: "sample.wav",
  model: "diffio-2",
  sampling: { steps: 12, guidance: 1.5 },
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

console.log(progress.status);
```

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
```
