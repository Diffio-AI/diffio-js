// Transcript edits, the saved mix, exports, transcripts and drafts, and the edit assistant.

import type { RequestOptions, Transport } from "../../core/transport";
import { queryString, segment } from "../../core/url";
import { pollUntil, type WaitOptions } from "../../core/poll";
import { generationPath } from "./generations";
import type {
  Generation,
  GenerationExport,
  GenerationExportCreateParams,
  GenerationExportGetParams,
  GenerationMix,
  GenerationMixSaveParams,
  Transcript,
  TranscriptAssistantTurn,
  TranscriptAssistantTurnCreateParams,
  TranscriptDraft,
  TranscriptDraftDeleteParams,
  TranscriptDraftDeleted,
  TranscriptDraftSaveParams,
  TranscriptEditCreateParams,
  TranscriptEditEstimate,
  TranscriptGetParams
} from "../types";

const DEFAULT_EXPORT_WAIT_TIMEOUT_SECONDS = 600;
const DEFAULT_TURN_WAIT_TIMEOUT_SECONDS = 600;

export class EditsResource {
  constructor(private readonly transport: Transport) {}

  /** `POST .../edits/estimate`: what an edit would bill; creates and charges nothing. */
  async estimate(
    projectId: string,
    generationId: string,
    params: TranscriptEditCreateParams,
    options?: RequestOptions
  ): Promise<TranscriptEditEstimate> {
    return this.transport.request<TranscriptEditEstimate>({
      method: "POST",
      path: `${generationPath(projectId, generationId)}/edits/estimate`,
      body: params ?? {},
      idempotent: true,
      options
    });
  }

  /**
   * `POST .../edits`: re-restores only the changed words of a finished Pro result. Returns the new
   * generation (`kind: "edit"`); follow it with `generations.wait`.
   */
  async create(
    projectId: string,
    generationId: string,
    params: TranscriptEditCreateParams,
    options?: RequestOptions
  ): Promise<Generation> {
    return this.transport.request<Generation>({
      method: "POST",
      path: `${generationPath(projectId, generationId)}/edits`,
      body: params ?? {},
      idempotent: false,
      acceptsIdempotencyKey: true,
      options
    });
  }
}

export class MixResource {
  constructor(private readonly transport: Transport) {}

  /** `GET .../mix`: the saved balance of the separated speech and background tracks. */
  async get(projectId: string, generationId: string, options?: RequestOptions): Promise<GenerationMix> {
    return this.transport.request<GenerationMix>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/mix`,
      idempotent: true,
      options
    });
  }

  /** `PUT .../mix`: saves `background_gain` (0 to 1) and `leveling`; send `revision` to refuse stale saves. */
  async save(
    projectId: string,
    generationId: string,
    params: GenerationMixSaveParams,
    options?: RequestOptions
  ): Promise<GenerationMix> {
    return this.transport.request<GenerationMix>({
      method: "PUT",
      path: `${generationPath(projectId, generationId)}/mix`,
      body: params,
      idempotent: true,
      options
    });
  }
}

export class ExportsResource {
  constructor(private readonly transport: Transport) {}

  /** `POST .../exports`: renders speech, background, a mix, both (zip) or the original as a file. */
  async create(
    projectId: string,
    generationId: string,
    params: GenerationExportCreateParams,
    options?: RequestOptions
  ): Promise<GenerationExport> {
    return this.transport.request<GenerationExport>({
      method: "POST",
      path: `${generationPath(projectId, generationId)}/exports`,
      body: params,
      // The same recipe returns the same export, so repeating it is safe.
      idempotent: true,
      options
    });
  }

  /** `GET .../exports/{export_id}`: its status and, once `ready`, a fresh `url`. */
  async get(
    projectId: string,
    generationId: string,
    exportId: string,
    params: GenerationExportGetParams = {},
    options?: RequestOptions
  ): Promise<GenerationExport> {
    return this.transport.request<GenerationExport>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/exports/${segment(exportId, "exportId")}${queryString({ file_name: params.file_name })}`,
      idempotent: true,
      options
    });
  }

  /** Polls `get` until the export is `ready` (default timeout 600 s). */
  async wait(
    projectId: string,
    generationId: string,
    exportId: string,
    options: WaitOptions<GenerationExport> & RequestOptions & GenerationExportGetParams = {}
  ): Promise<GenerationExport> {
    const { timeout, pollInterval, onProgress, file_name, ...requestOptions } = options;
    return pollUntil(
      () => this.get(projectId, generationId, exportId, { file_name }, requestOptions),
      (item) => item.status === "ready",
      "export",
      { timeout, pollInterval, onProgress, signal: options.signal, defaultTimeout: DEFAULT_EXPORT_WAIT_TIMEOUT_SECONDS }
    );
  }
}

export class TranscriptsResource {
  constructor(private readonly transport: Transport) {}

  /** `GET .../transcript`: the word-timed transcript of a finished generation. */
  async get(
    projectId: string,
    generationId: string,
    params: TranscriptGetParams = {},
    options?: RequestOptions
  ): Promise<Transcript> {
    return this.transport.request<Transcript>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/transcript${queryString({ preview_seconds: params.preview_seconds })}`,
      idempotent: true,
      options
    });
  }

  /** `GET .../transcript/draft`: the saved editor state (`data` is null when nothing is saved). */
  async getDraft(projectId: string, generationId: string, options?: RequestOptions): Promise<TranscriptDraft> {
    return this.transport.request<TranscriptDraft>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/transcript/draft`,
      idempotent: true,
      options
    });
  }

  /** `PUT .../transcript/draft`: saves `data`; send the `revision` you read to refuse stale saves. */
  async saveDraft(
    projectId: string,
    generationId: string,
    params: TranscriptDraftSaveParams,
    options?: RequestOptions
  ): Promise<TranscriptDraft> {
    return this.transport.request<TranscriptDraft>({
      method: "PUT",
      path: `${generationPath(projectId, generationId)}/transcript/draft`,
      body: params,
      idempotent: true,
      options
    });
  }

  /** `DELETE .../transcript/draft`: deletes the draft (`revision` makes it conditional). */
  async deleteDraft(
    projectId: string,
    generationId: string,
    params: TranscriptDraftDeleteParams = {},
    options?: RequestOptions
  ): Promise<TranscriptDraftDeleted> {
    return this.transport.request<TranscriptDraftDeleted>({
      method: "DELETE",
      path: `${generationPath(projectId, generationId)}/transcript/draft${queryString({ revision: params.revision })}`,
      idempotent: true,
      options
    });
  }
}

export class AssistantResource {
  constructor(private readonly transport: Transport) {}

  /** `POST .../transcript/assistant/turns`: asks the edit assistant; answers 202 with `status: "processing"`. */
  async createTurn(
    projectId: string,
    generationId: string,
    params: TranscriptAssistantTurnCreateParams,
    options?: RequestOptions
  ): Promise<TranscriptAssistantTurn> {
    return this.transport.request<TranscriptAssistantTurn>({
      method: "POST",
      path: `${generationPath(projectId, generationId)}/transcript/assistant/turns`,
      body: params,
      idempotent: false,
      options
    });
  }

  /** `GET .../transcript/assistant/turns/{turn_id}`. */
  async getTurn(
    projectId: string,
    generationId: string,
    turnId: string,
    options?: RequestOptions
  ): Promise<TranscriptAssistantTurn> {
    return this.transport.request<TranscriptAssistantTurn>({
      method: "GET",
      path: `${generationPath(projectId, generationId)}/transcript/assistant/turns/${segment(turnId, "turnId")}`,
      idempotent: true,
      options
    });
  }

  /** Polls `getTurn` until the turn is `complete` (default timeout 600 s). */
  async waitTurn(
    projectId: string,
    generationId: string,
    turnId: string,
    options: WaitOptions<TranscriptAssistantTurn> & RequestOptions = {}
  ): Promise<TranscriptAssistantTurn> {
    const { timeout, pollInterval, onProgress, ...requestOptions } = options;
    return pollUntil(
      () => this.getTurn(projectId, generationId, turnId, requestOptions),
      (turn) => turn.status === "complete",
      "assistant turn",
      { timeout, pollInterval: pollInterval ?? 1.5, onProgress, signal: options.signal, defaultTimeout: DEFAULT_TURN_WAIT_TIMEOUT_SECONDS }
    );
  }
}
