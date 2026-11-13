// Turns what callers pass as "a file" into an UploadSource, and writes downloads to disk in Node.
// Accepted: a file path (Node only), a Blob or File (browsers and Node 18+), a Uint8Array / Buffer,
// an ArrayBuffer, or an ArrayBufferView.

import { DiffioError } from "../errors";
import type { UploadSource } from "./edgeUpload";
import { nodeRequire } from "./node";

export type FileInput = string | Blob | Uint8Array | ArrayBuffer | ArrayBufferView;

export interface ResolvedFile {
  source: UploadSource;
  /** Base name from the path or File, when there is one. */
  file_name: string | null;
  /** Type from the Blob, when it has one. */
  content_type: string | null;
}

function nodeModule<T>(id: string): T {
  const loaded = nodeRequire<T>(id);
  if (!loaded) throw new DiffioError("File paths work only in Node; pass a Blob, File or bytes instead.");
  return loaded;
}

const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== "undefined" && value instanceof Blob ||
  (Boolean(value) && typeof value === "object" && typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).slice === "function" && typeof (value as Blob).size === "number");

/** Opens a file input for reading parts. */
export async function resolveFileInput(file: FileInput): Promise<ResolvedFile> {
  if (typeof file === "string") {
    if (!file) throw new DiffioError("file is required");
    const fs = nodeModule<typeof import("node:fs/promises")>("node:fs/promises");
    const path = nodeModule<typeof import("node:path")>("node:path");
    const handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    return {
      file_name: path.basename(file),
      content_type: null,
      source: {
        sizeBytes: size,
        async read(start, end) {
          const length = end - start;
          const buffer = new Uint8Array(length);
          let offset = 0;
          while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
            if (bytesRead === 0) throw new DiffioError("The file became shorter while it was uploading.");
            offset += bytesRead;
          }
          return buffer;
        },
        close: () => handle.close()
      }
    };
  }
  if (isBlob(file)) {
    const name = (file as { name?: unknown }).name;
    return {
      file_name: typeof name === "string" && name ? name : null,
      content_type: file.type || null,
      source: {
        sizeBytes: file.size,
        read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer())
      }
    };
  }
  let bytes: Uint8Array;
  if (file instanceof Uint8Array) bytes = file;
  else if (file instanceof ArrayBuffer) bytes = new Uint8Array(file);
  else if (ArrayBuffer.isView(file)) bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  else throw new DiffioError("file must be a path, Blob, File, Uint8Array, Buffer or ArrayBuffer");
  return {
    file_name: null,
    content_type: null,
    source: { sizeBytes: bytes.byteLength, read: async (start, end) => bytes.subarray(start, end) }
  };
}

/** Media types for the extensions the API accepts (api_projects.py); others are left to the API. */
const MEDIA_TYPES: Record<string, string> = {
  "3g2": "video/3gpp2", "3gp": "video/3gpp", "3gpp": "video/3gpp", aac: "audio/aac", aif: "audio/aiff",
  aiff: "audio/aiff", amr: "audio/amr", au: "audio/basic", avi: "video/x-msvideo", caf: "audio/x-caf",
  flac: "audio/flac", m4a: "audio/mp4", m4b: "audio/mp4", m4v: "video/mp4", mka: "audio/x-matroska",
  mkv: "video/x-matroska", mov: "video/quicktime", mp2: "audio/mpeg", mp3: "audio/mpeg", mp4: "video/mp4",
  mpeg: "video/mpeg", mpg: "video/mpeg", oga: "audio/ogg", ogg: "audio/ogg", ogv: "video/ogg", opus: "audio/opus",
  wav: "audio/wav", weba: "audio/webm", webm: "video/webm", wma: "audio/x-ms-wma", wmv: "video/x-ms-wmv"
};

/** Guesses a media type from a file name's extension; null when unknown. */
export function guessContentType(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  return match ? MEDIA_TYPES[match[1].toLowerCase()] ?? null : null;
}

/** Writes a fetch response body to a file in Node, streaming it; returns the bytes written. */
export async function writeResponseToFile(response: Response, filePath: string): Promise<number> {
  const fs = nodeModule<typeof import("node:fs")>("node:fs");
  const path = nodeModule<typeof import("node:path")>("node:path");
  const dir = path.dirname(filePath);
  if (dir) await fs.promises.mkdir(dir, { recursive: true });
  const partial = `${filePath}.part`;
  const stream = fs.createWriteStream(partial);
  let written = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (!stream.write(value)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
    await fs.promises.rename(partial, filePath);
  } catch (error) {
    stream.destroy();
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  return written;
}
