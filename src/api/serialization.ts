import type { EdgeUploadSession } from "../core/edgeUpload";
import type {
  AccountSettingsResponse,
  ApiKeyResponse,
  ApiKeysListResponse,
  AudioIsolationResult,
  CompleteProjectUploadResponse,
  CreateGenerationResponse,
  CreateProjectResponse,
  GenerationQueueStatus,
  GenerationStageProgress,
  GenerationWebhookEvent,
  GenerationDownloadResponse,
  GenerationProgressResponse,
  GenerationProgressStage,
  GenerationTranscription,
  ListProjectGenerationsResponse,
  ListProjectsResponse,
  ProjectGenerationSummary,
  ProjectSummary,
  ProjectUploadSession,
  UsageSummaryResponse,
  WebhookConfigureResponse,
  WebhookTestEventResponse
} from "./types";

/** Builds the public createProject result; it omits the upload token, which can still overwrite the upload. */
export function createProjectUploadResult(
  data: any,
  session: EdgeUploadSession,
  uploadCompletion: CompleteProjectUploadResponse
): CreateProjectResponse {
  const upload: ProjectUploadSession = {
    uploadSessionId: session.uploadSessionId,
    edgeBaseUrl: session.edgeBaseUrl,
    objectKey: session.objectKey,
    partSizeBytes: session.partSizeBytes,
    maxBytes: session.maxBytes,
    expiresAt: session.expiresAt
  };
  return {
    apiProjectId: data.apiProjectId,
    upload,
    objectPath: data.objectPath ?? session.objectKey,
    expiresAt: data.expiresAt ?? session.expiresAt,
    uploadCompletion
  };
}

export function parseCompleteProjectUploadResponse(data: any): CompleteProjectUploadResponse {
  const sizeBytes = data?.sizeBytes;
  return {
    apiProjectId: data?.apiProjectId,
    status: data?.status ?? "uploaded",
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null
  };
}

export function parseProjectSummary(data: any): ProjectSummary {
  return {
    apiProjectId: data.apiProjectId,
    status: data.status || "uploading",
    originalFileName: data.originalFileName ?? null,
    contentType: data.contentType ?? null,
    hasVideo: Boolean(data.hasVideo),
    generationCount: Number(data.generationCount || 0),
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null
  };
}

export function parseListProjectsResponse(data: any): ListProjectsResponse {
  const items = Array.isArray(data?.projects) ? data.projects : [];
  return { projects: items.filter(Boolean).map(parseProjectSummary) };
}

export function parseCreateGenerationResponse(data: any): CreateGenerationResponse {
  return {
    generationId: data.generationId,
    apiProjectId: data.apiProjectId,
    modelKey: data.modelKey,
    status: data.status,
    ...(data.idempotentReplay == null
      ? {}
      : { idempotentReplay: Boolean(data.idempotentReplay) })
  };
}

export function parseProjectGenerationSummary(data: any): ProjectGenerationSummary {
  const progress = data.progress;
  return {
    generationId: data.generationId,
    status: data.status || "queued",
    modelKey: data.modelKey ?? null,
    progress: progress != null ? Number(progress) : null,
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null
  };
}

export function parseListProjectGenerationsResponse(data: any): ListProjectGenerationsResponse {
  const items = Array.isArray(data?.generations) ? data.generations : [];
  return {
    apiProjectId: data.apiProjectId,
    generations: items.filter(Boolean).map(parseProjectGenerationSummary)
  };
}

export function parseGenerationProgressStage(data: any): GenerationProgressStage {
  return {
    jobId: data?.jobId ?? null,
    jobState: data?.jobState ?? null,
    status: data?.status || "pending",
    progress: Number(data?.progress || 0),
    statusMessage: data?.statusMessage ?? null,
    error: data?.error ?? null,
    errorDetails: data?.errorDetails ?? null
  };
}

export function parseGenerationProgressResponse(data: any): GenerationProgressResponse {
  const restoredVideo = data?.restoredVideo;
  const transcription = parseGenerationTranscription(data?.transcription);
  const stageProgress = parseGenerationStageProgress(data?.stageProgress);
  const queue = parseGenerationQueueStatus(data?.queue);
  return {
    generationId: data.generationId,
    apiProjectId: data.apiProjectId,
    status: data.status,
    hasVideo: Boolean(data.hasVideo),
    preProcessing: parseGenerationProgressStage(data.preProcessing),
    inference: parseGenerationProgressStage(data.inference),
    restoredVideo: restoredVideo ? parseGenerationProgressStage(restoredVideo) : null,
    ...(typeof data?.stage === "string" ? { stage: data.stage } : {}),
    ...(stageProgress ? { stageProgress } : {}),
    ...(queue ? { queue } : {}),
    ...(transcription ? { transcription } : {}),
    error: data.error ?? null,
    errorDetails: data.errorDetails ?? null
  };
}

export function parseGenerationDownloadResponse(data: any): GenerationDownloadResponse {
  return {
    generationId: data.generationId,
    apiProjectId: data.apiProjectId,
    downloadType: data.downloadType,
    downloadUrl: data.downloadUrl,
    fileName: data.fileName,
    storagePath: data.storagePath,
    mimeType: data.mimeType
  };
}

export function parseWebhookTestEventResponse(data: any): WebhookTestEventResponse {
  return {
    svixMessageId: data.svixMessageId,
    eventId: data.eventId,
    eventType: data.eventType,
    mode: data.mode ?? null,
    apiKeyId: data.apiKeyId ?? null
  };
}

export function parseAccountSettingsResponse(data: any): AccountSettingsResponse {
  return {
    apiKeyId: data?.apiKeyId ?? null,
    account: data?.account && typeof data.account === "object" ? data.account : {}
  };
}

export function parseApiKeyResponse(data: any): ApiKeyResponse {
  return {
    key: data?.key,
    keyId: data?.keyId,
    label: data?.label ?? "",
    status: data?.status ?? "active",
    keyPrefix: data?.keyPrefix ?? "",
    role: data?.role ?? "scoped",
    scopes: Array.isArray(data?.scopes) ? data.scopes.map(String) : [],
    resourceBounds: data?.resourceBounds && typeof data.resourceBounds === "object" ? data.resourceBounds : {},
    parentKeyId: data?.parentKeyId ?? null,
    createdAt: data?.createdAt ?? null,
    rotatedAt: data?.rotatedAt ?? null,
    revokedAt: data?.revokedAt ?? null,
    permissions: data?.permissions && typeof data.permissions === "object" ? data.permissions : undefined
  };
}

export function parseApiKeysListResponse(data: any): ApiKeysListResponse {
  const items = Array.isArray(data?.keys) ? data.keys : [];
  return { keys: items.filter(Boolean).map(parseApiKeyResponse) };
}

export function parseUsageSummaryResponse(data: any): UsageSummaryResponse {
  return {
    usage: data?.usage && typeof data.usage === "object" ? data.usage : {},
    billing: data?.billing && typeof data.billing === "object" ? data.billing : {}
  };
}

export function parseWebhookConfigureResponse(data: any): WebhookConfigureResponse {
  return {
    webhook: data?.webhook && typeof data.webhook === "object" ? data.webhook : {}
  };
}

export function parseGenerationWebhookEvent(data: any): GenerationWebhookEvent {
  const transcription = parseGenerationTranscription(data?.transcription);
  return {
    eventType: data.eventType,
    eventId: data.eventId,
    createdAt: data.createdAt,
    apiKeyId: data.apiKeyId,
    apiProjectId: data.apiProjectId ?? null,
    generationId: data.generationId,
    status: data.status,
    hasVideo: data.hasVideo ?? null,
    modelKey: data.modelKey ?? null,
    ...(transcription ? { transcription } : {}),
    error: data.error ?? null,
    errorDetails: data.errorDetails ?? null
  };
}

const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseGenerationStageProgress(data: unknown): GenerationStageProgress | undefined {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const source = data as Record<string, unknown>;
  const progress: GenerationStageProgress = {};
  for (const key of [
    "overallPercent",
    "stagePercent",
    "bytesDone",
    "bytesTotal",
    "availableThroughSeconds",
    "durationSeconds"
  ] as const) {
    const value = optionalNumber(source[key]);
    if (value != null) {
      progress[key] = value;
    }
  }
  return progress;
}

function parseGenerationQueueStatus(data: unknown): GenerationQueueStatus | undefined {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const source = data as Record<string, unknown>;
  return {
    position: optionalNumber(source.position),
    connectedWorkers: optionalNumber(source.connectedWorkers),
    idleWorkers: optionalNumber(source.idleWorkers),
    busyWorkers: optionalNumber(source.busyWorkers),
    waitReason: typeof source.waitReason === "string" ? source.waitReason : null,
    message: typeof source.message === "string" ? source.message : ""
  };
}

function parseGenerationTranscription(data: unknown): GenerationTranscription | undefined {
  if (data == null || typeof data !== "object" || !("status" in data)) {
    return undefined;
  }
  const { status } = data;
  if (status === "pending" || status === "available" || status === "unavailable") {
    return { status };
  }
  return undefined;
}

export function createAudioIsolationResult(
  project: CreateProjectResponse,
  generation: CreateGenerationResponse
): AudioIsolationResult {
  return { project, generation };
}
