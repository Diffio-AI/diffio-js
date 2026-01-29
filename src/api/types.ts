export type ModelKey = "diffio-2" | "diffio-2-flash" | "diffio-3";
export type DownloadType = "audio" | "video";
export type WebhookMode = "test" | "live";
export type WebhookEventType =
  | "generation.queued"
  | "generation.processing"
  | "generation.failed"
  | "generation.completed";
export type GenerationWebhookStatus = "queued" | "processing" | "error" | "complete";

export interface CreateProjectResponse {
  apiProjectId: string;
  uploadUrl: string;
  uploadMethod: string;
  objectPath: string;
  bucket: string;
  expiresAt: string;
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
  modelKey: ModelKey | string;
  status: string;
}

export interface ProjectGenerationSummary {
  generationId: string;
  status: string;
  modelKey?: ModelKey | string | null;
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

export interface GenerationProgressResponse {
  generationId: string;
  apiProjectId: string;
  status: string;
  hasVideo: boolean;
  preProcessing: GenerationProgressStage;
  inference: GenerationProgressStage;
  restoredVideo?: GenerationProgressStage | null;
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
  bucket: string;
  mimeType: string;
}

export interface AudioIsolationResult {
  project: CreateProjectResponse;
  generation: CreateGenerationResponse;
}

export interface WebhookPortalResponse {
  portalUrl: string;
  mode?: WebhookMode | string | null;
  apiKeyId?: string | null;
}

export interface WebhookTestEventResponse {
  svixMessageId: string;
  eventId: string;
  eventType: WebhookEventType | string;
  mode?: WebhookMode | string | null;
  apiKeyId?: string | null;
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
  modelKey?: ModelKey | string | null;
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
}
