// Request and response shapes of Diffio API v2 (https://api.diffio.ai/v2/openapi.json).
// Field names are snake_case exactly as on the wire, in both directions.

export type { ListResponse } from "../core/pagination";

/** Shape of a v2 error body. The SDK throws it as DiffioApiError. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string | null;
    details?: Record<string, unknown>;
  };
}

/** The `error` of a failed project, export or assistant turn. */
export interface ResourceError {
  code: string;
  message: string;
}

/** The `error` of a failed generation. */
export interface GenerationError extends ResourceError {
  retryable: boolean;
  explanation: string | null;
}

// ---- models -------------------------------------------------------------------------------------

export type ModelStatus = "hosted" | "alias" | "retired";

/** Hosted names and the tier aliases that always mean the current model of a tier. Any string is accepted. */
export type ModelName = "diffio-flash" | "diffio-pro" | "diffio-4.7-flash" | "diffio-4.7-pro" | (string & {});

export interface Model {
  id: string;
  object: "model";
  status: ModelStatus;
  label: string | null;
  served_by: string;
  price_per_hour_usd: number;
}

// ---- projects -----------------------------------------------------------------------------------

export type ProjectStatus = "awaiting_upload" | "preparing" | "ready" | "failed";

/** `generation` on `POST /projects`: request the first restore now; it starts once the upload is ready. */
export interface ProjectGenerationCreate {
  model: ModelName;
  label?: string;
  sampling?: Record<string, unknown>;
}

export interface ProjectCreateParams {
  /** File name with a media extension (`.mp3`, `.wav`, `.mp4`, ...). */
  file_name: string;
  content_type?: string;
  size_bytes?: number;
  /** Up to 50 string values; keys up to 40 characters, values up to 500. */
  metadata?: Record<string, string>;
  generation?: ProjectGenerationCreate;
  /**
   * Not a body field: the SDK sends it as the `Diffio-End-User` header (same as `options.endUser`).
   */
  end_user?: string;
}

export interface UploadRequest {
  method: "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  returns: string[];
  description: string;
}

/** Where and how to send the media bytes: Diffio's media host, in parts. `projects.upload` does all of it. */
export interface ProjectUpload {
  upload_session_id: string;
  edge_base_url: string;
  upload_token: string;
  part_size_bytes: number;
  max_bytes: number;
  expires_at: string;
  requests: {
    start: UploadRequest;
    part: UploadRequest;
    complete: UploadRequest;
    abort?: UploadRequest;
    [name: string]: UploadRequest | undefined;
  };
}

export interface Project {
  id: string;
  object: "project";
  status: ProjectStatus;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  has_video: boolean;
  end_user: string | null;
  metadata: Record<string, string>;
  generation_count: number;
  video_preview_status: "preparing" | "ready" | "failed" | null;
  latest_generation: Generation | null;
  share_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  error: ResourceError | null;
}

/** A project as `POST /projects` and `POST /projects/{id}/upload` answer it. */
export interface ProjectWithUpload extends Project {
  upload: ProjectUpload | null;
}

export interface ProjectDeleted {
  id: string;
  object: "project";
  deleted: true;
  deleted_generations: number;
  deleted_media_objects: number;
}

export interface ListParams {
  /** 1 to 100, default 20. */
  limit?: number;
  /** The previous page's `next_cursor`. */
  cursor?: string;
}

// ---- generations --------------------------------------------------------------------------------

export type GenerationStatus = "queued" | "processing" | "complete" | "failed";

export interface GenerationCreateParams {
  model: ModelName;
  label?: string;
  sampling?: Record<string, unknown>;
}

export interface GenerationStageProgress {
  overall_percent?: number;
  stage_percent?: number;
  bytes_done?: number;
  bytes_total?: number;
  available_through_seconds?: number;
  duration_seconds?: number;
  [key: string]: unknown;
}

export interface GenerationQueue {
  position: number | null;
  connected_workers: number | null;
  idle_workers: number | null;
  busy_workers: number | null;
  wait_reason: "all_busy" | "no_workers" | "next_in_line" | null;
  message: string | null;
  [key: string]: unknown;
}

export interface GenerationWarning {
  code: string;
  languages?: string[];
  message: string;
  [key: string]: unknown;
}

export interface GenerationEdit {
  edit_count: number | null;
  max_windows: number | null;
  windows: number | null;
  windows_done: number | null;
  retry_windows?: number | null;
  ranges: Array<{ start: number; end: number }>;
  billable_seconds: number | null;
  cut_seconds: number | null;
  request_id: string | null;
  language: string | null;
  tighten: { close_removed_gaps: boolean; max_pause_seconds: number | null } | null;
  [key: string]: unknown;
}

/** Names `files_available` and `GET .../media` can list. */
export type GenerationFileName =
  | "original"
  | "audio"
  | "audio_mixed"
  | "video"
  | "hls_master"
  | "hls_restored"
  | "hls_original"
  | "video_hls"
  | "waveform_restored"
  | "waveform_original"
  | "transcript"
  | "edited_transcript"
  | "stems_manifest"
  | "metadata"
  | (string & {});

export interface Generation {
  id: string;
  object: "generation";
  project_id: string;
  status: GenerationStatus;
  model: string | null;
  requested_model: string | null;
  substituted: boolean;
  price_per_hour_usd: number | null;
  stage: string | null;
  stage_progress: GenerationStageProgress | null;
  queue: GenerationQueue | null;
  warnings: GenerationWarning[];
  label: string | null;
  kind: "restore" | "edit";
  source_generation_id: string | null;
  edit: GenerationEdit | null;
  transcript_editable: boolean;
  duration_seconds: number | null;
  quality_score: number | null;
  transcription_status: "preparing" | "ready" | "failed" | null;
  files_available: GenerationFileName[];
  error: GenerationError | null;
  stems_status: "preparing" | "ready" | "failed" | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface GenerationMediaParams {
  /** 4 to 3600: a preview grant names only playlists and other preview-readable files. */
  preview_seconds?: number;
}

export interface GenerationMedia {
  object: "generation_media";
  project_id: string;
  generation_id: string;
  status: GenerationStatus;
  /** File name -> URL. URLs need no API key and stop working at `expires_at` (6 hours). */
  files: Partial<Record<GenerationFileName, string>>;
  base_url: string;
  expires_at: string;
  preview_seconds: number | null;
}

// ---- edits --------------------------------------------------------------------------------------

export interface TranscriptWordInput {
  id?: string;
  text?: string;
  word?: string;
  start?: number | null;
  end?: number | null;
  probability?: number | null;
  speaker?: string;
  language?: string;
  changed?: boolean;
  regenerate?: boolean;
  [key: string]: unknown;
}

export interface TranscriptEditCreateParams {
  /** The whole transcript after editing, in order; `text: ""` removes a word. */
  words?: TranscriptWordInput[];
  tighten?: { close_removed_gaps?: boolean; max_pause_seconds?: number };
  /** Your own id, echoed as `edit.request_id` (`[A-Za-z0-9_-]{1,64}`). Not an idempotency key. */
  request_id?: string;
}

export interface TranscriptEditEstimate {
  object: "transcript_edit_estimate";
  project_id: string;
  generation_id: string;
  edit_count: number | null;
  max_windows: number | null;
  window_seconds: number;
  max_billable_seconds: number;
}

// ---- mix and exports ----------------------------------------------------------------------------

export interface GenerationMix {
  object: "generation_mix";
  project_id: string;
  generation_id: string;
  background_gain: number;
  leveling: boolean;
  revision: string;
  stems_revision: string | null;
}

export interface GenerationMixSaveParams {
  /** 0 = speech only, 1 = all of the background. */
  background_gain: number;
  leveling?: boolean;
  /** The `revision` you read; a stale one is refused with 409 `revision_conflict`. */
  revision?: string;
}

export type ExportArtifact = "speech" | "background" | "mix" | "both" | "original";
export type ExportFormat = "wav" | "mp3" | "m4a" | "mp4" | "zip";

export interface GenerationExportCreateParams {
  artifact: ExportArtifact;
  format: ExportFormat;
  inline?: boolean;
  background_gain?: number;
  leveling?: boolean;
  /** Download name without extension, up to 200 characters. */
  file_name?: string;
}

export interface GenerationExportGetParams {
  file_name?: string;
}

export interface GenerationExport {
  object: "generation_export";
  id: string;
  project_id: string;
  generation_id: string;
  status: "queued" | "processing" | "ready" | "failed";
  artifact: string | null;
  format: string | null;
  background_gain: number | null;
  leveling: boolean;
  inline: boolean;
  url: string | null;
  error: ResourceError | null;
}

// ---- transcripts --------------------------------------------------------------------------------

export interface TranscriptWord {
  id: string;
  text: string;
  start: number | null;
  end: number | null;
  probability: number | null;
  speaker?: string;
  language?: string;
  [key: string]: unknown;
}

export interface TranscriptGetParams {
  preview_seconds?: number;
}

export interface Transcript {
  object: "transcript";
  project_id: string;
  generation_id: string;
  text: string;
  words: TranscriptWord[];
  preview_seconds: number | null;
  truncated: boolean;
}

export interface TranscriptDraft {
  object: "transcript_draft";
  project_id: string;
  generation_id: string;
  revision: string;
  data: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TranscriptDraftSaveParams {
  data: Record<string, unknown>;
  revision?: string;
}

export interface TranscriptDraftDeleteParams {
  revision?: string;
}

export interface TranscriptDraftDeleted {
  object: "transcript_draft";
  project_id: string;
  generation_id: string;
  deleted: true;
  revision: string;
}

// ---- edit assistant -----------------------------------------------------------------------------

export interface TranscriptAssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TranscriptAssistantTurnCreateParams {
  messages: TranscriptAssistantMessage[];
  words?: TranscriptWordInput[];
  selection?: { word_ids: string[] } | null;
  playhead_seconds?: number | null;
  source?: string;
}

export interface TranscriptAssistantTurn {
  object: "transcript_assistant_turn";
  id: string;
  project_id: string;
  generation_id: string;
  status: "processing" | "complete" | "failed";
  created_at: string | null;
  completed_at: string | null;
  error: ResourceError | null;
  reply?: string;
  proposals?: Array<Record<string, unknown>>;
  moments?: Array<Record<string, unknown>>;
  unclear_word_ids?: string[];
  speaker_turns?: Array<Record<string, unknown>>;
  shortening?: Record<string, unknown> | null;
  feedback_offer?: Record<string, unknown> | null;
  notices?: string[];
  windows_total?: number;
  [key: string]: unknown;
}

// ---- shares -------------------------------------------------------------------------------------

export interface ProjectSharePublishParams {
  /** Pin a finished generation; default is the project's newest finished one. */
  generation_id?: string;
  preview_seconds?: number;
}

export interface ProjectShare {
  object: "project_share";
  id: string;
  project_id: string;
  generation_id: string | null;
  file_name: string | null;
  content_type: string | null;
  created_at: string | null;
  has_video: boolean;
  duration_seconds: number | null;
  preview_seconds: number | null;
  files: Partial<Record<GenerationFileName, string>>;
  base_url: string | null;
}

export interface ProjectShareRevoked {
  object: "project_share";
  id: string | null;
  project_id: string;
  deleted: true;
}

// ---- usage --------------------------------------------------------------------------------------

export interface UsageParams {
  /** ISO 8601 date or datetime; default the start of this month (UTC). */
  start?: string;
  /** ISO 8601 date or datetime; default now. At most 366 days after `start`. */
  end?: string;
}

export interface UsageByModel {
  model: string;
  generations: number;
  billable_seconds: number;
  list_price_usd: number;
}

export interface Usage {
  object: "usage";
  start: string | null;
  end: string | null;
  end_user: string | null;
  generations: number;
  billable_seconds: number;
  list_price_usd: number;
  by_model: UsageByModel[];
}

// ---- webhooks -----------------------------------------------------------------------------------

export interface WebhookPortal {
  object: "webhook_portal";
  url: string;
  event_types: WebhookEventType[];
}

export type WebhookEventType =
  | "generation.completed"
  | "generation.failed"
  | "generation.stems_ready"
  | "generation.stems_failed"
  | "export.ready"
  | "export.failed"
  | "transcript_assistant_turn.completed"
  | "transcript_assistant_turn.failed"
  | "project.ready"
  | "project.failed";

export interface WebhookEventData {
  object: "generation" | "generation_export" | "transcript_assistant_turn" | "project" | (string & {});
  id: string;
  project_id?: string;
  generation_id?: string;
  end_user?: string | null;
  status?: string;
  kind?: "restore" | "edit";
  error_code?: string;
  stems_status?: string;
  [key: string]: unknown;
}

/** A verified webhook delivery: `{"type", "id", "created_at", "data"}`. De-duplicate on `id`. */
export interface WebhookEvent {
  type: WebhookEventType | (string & {});
  id: string;
  created_at: string;
  data: WebhookEventData;
}
