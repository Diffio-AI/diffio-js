/** Models new generations can use (api/model_registry.json in diffio-ui); each has its own endpoint. */
export type ModelKey = "diffio-4.5-flash" | "diffio-4.5-pro";
export type DownloadType = "audio" | "video" | "transcript";
export type WebhookMode = "test" | "live";
export type WebhookEventType =
  | "generation.queued"
  | "generation.processing"
  | "generation.failed"
  | "generation.completed";
export type GenerationWebhookStatus = "queued" | "processing" | "error" | "complete";
export type TranscriptionStatus = "pending" | "available" | "unavailable";

export interface GenerationTranscription {
  status: TranscriptionStatus;
}

/** The edge upload session create_project opened; the upload token stays inside the SDK. */
export interface ProjectUploadSession {
  uploadSessionId: string;
  edgeBaseUrl: string;
  objectKey: string;
  partSizeBytes: number;
  maxBytes: number;
  expiresAt: string;
}

/** Response of `/v1/complete_project_upload`; repeated calls return the same answer. */
export interface CompleteProjectUploadResponse {
  apiProjectId: string;
  status: "uploaded" | string;
  sizeBytes: number | null;
}

/** A created project whose media `createProject` already uploaded through the edge and confirmed. */
export interface CreateProjectResponse {
  apiProjectId: string;
  upload: ProjectUploadSession;
  objectPath: string;
  expiresAt: string;
  uploadCompletion: CompleteProjectUploadResponse;
}

export interface ProjectSummary {
  apiProjectId: string;
  status: string;
  originalFileName?: string | null;
  contentType?: string | null;
  hasVideo: boolean;
  generationCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
}

export interface CreateGenerationResponse {
  generationId: string;
  apiProjectId: string;
  /** A string because generations created before a model was retired keep their original key. */
  modelKey: string;
  status: string;
  idempotentReplay?: boolean;
}

export interface ProjectGenerationSummary {
  generationId: string;
  status: string;
  /** Older generations keep the key of the model that produced them. */
  modelKey?: string | null;
  progress?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ListProjectGenerationsResponse {
  apiProjectId: string;
  generations: ProjectGenerationSummary[];
}

export interface GenerationProgressStage {
  jobId?: string | null;
  jobState?: string | null;
  status: string;
  progress: number;
  statusMessage?: string | null;
  error?: string | null;
  errorDetails?: string | null;
}

/** The one stage a generation is in, as `get_generation_progress` reports it. */
export type GenerationStage =
  | "pending"
  | "preparing"
  | "transcribing"
  | "queued"
  | "starting"
  | "downloading"
  | "decoding"
  | "restoring"
  | "finalizing"
  | "uploading"
  | "complete"
  | "failed";

/** Progress within the current fleet stage; every field is optional and present only when known. */
export interface GenerationStageProgress {
  overallPercent?: number;
  stagePercent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  availableThroughSeconds?: number;
  durationSeconds?: number;
}

/** Why a queued generation waits for a Mac fleet worker. */
export interface GenerationQueueStatus {
  position: number | null;
  connectedWorkers: number | null;
  idleWorkers: number | null;
  busyWorkers: number | null;
  waitReason: "all_busy" | "no_workers" | "next_in_line" | string | null;
  message: string;
}

export interface GenerationProgressResponse {
  generationId: string;
  apiProjectId: string;
  status: string;
  hasVideo: boolean;
  preProcessing: GenerationProgressStage;
  inference: GenerationProgressStage;
  restoredVideo?: GenerationProgressStage | null;
  /** Omitted by older API versions. */
  stage?: GenerationStage | string;
  /** Present while a fleet stage reports progress. */
  stageProgress?: GenerationStageProgress;
  /** Present while the generation waits in the fleet queue. */
  queue?: GenerationQueueStatus;
  /** Independent of media completion; omitted by older API versions. */
  transcription?: GenerationTranscription;
  error?: string | null;
  errorDetails?: string | null;
}

export interface GenerationDownloadResponse {
  generationId: string;
  apiProjectId: string;
  downloadType: DownloadType | string;
  downloadUrl: string;
  fileName: string;
  storagePath: string;
  mimeType: string;
}

export interface AudioIsolationResult {
  project: CreateProjectResponse;
  generation: CreateGenerationResponse;
}

export interface WebhookTestEventResponse {
  svixMessageId: string;
  eventId: string;
  eventType: WebhookEventType | string;
  mode?: WebhookMode | string | null;
  apiKeyId?: string | null;
}

export interface AccountSettingsResponse {
  apiKeyId?: string | null;
  account: Record<string, unknown>;
}

export interface ApiKeyResponse {
  key?: string;
  keyId: string;
  label: string;
  status: string;
  keyPrefix: string;
  role: string;
  scopes: string[];
  resourceBounds: Record<string, unknown>;
  parentKeyId?: string | null;
  createdAt?: string | null;
  rotatedAt?: string | null;
  revokedAt?: string | null;
  permissions?: Record<string, unknown>;
}

export interface ApiKeysListResponse {
  keys: ApiKeyResponse[];
}

export interface UsageSummaryResponse {
  usage: Record<string, unknown>;
  billing: Record<string, unknown>;
}

export interface WebhookConfigureResponse {
  webhook: Record<string, unknown>;
}

export interface GenerationWebhookEvent {
  eventType: WebhookEventType | string;
  eventId: string;
  createdAt: string;
  apiKeyId: string;
  apiProjectId?: string | null;
  generationId: string;
  status: GenerationWebhookStatus | string;
  hasVideo?: boolean | null;
  /** Older generations keep the key of the model that produced them. */
  modelKey?: string | null;
  /** A completed generation may still have a pending or unavailable transcript. */
  transcription?: GenerationTranscription;
  error?: string | null;
  errorDetails?: string | null;
}

export interface RestoreMetadata {
  ok: boolean;
  stage: string;
  apiProjectId: string | null;
  generationId: string | null;
  project: CreateProjectResponse | null;
  generation: CreateGenerationResponse | null;
  progress: GenerationProgressResponse | null;
  download: GenerationDownloadResponse | null;
  downloadType: DownloadType | string | null;
  downloadUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
  status: string | null;
  error: string | null;
  errorDetails: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  /** HTTP error details retained when a restore helper returns instead of throwing. */
  statusCode?: number;
  responseBody?: unknown;
}
