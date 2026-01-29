import type {
  AudioIsolationResult,
  CreateGenerationResponse,
  CreateProjectResponse,
  GenerationWebhookEvent,
  GenerationDownloadResponse,
  GenerationProgressResponse,
  GenerationProgressStage,
  ListProjectGenerationsResponse,
  ListProjectsResponse,
  ProjectGenerationSummary,
  ProjectSummary,
  WebhookPortalResponse,
  WebhookTestEventResponse
} from "./types";

export function parseCreateProjectResponse(data: any): CreateProjectResponse {
  return {
    apiProjectId: data.apiProjectId,
    uploadUrl: data.uploadUrl,
    uploadMethod: data.uploadMethod || "PUT",
    objectPath: data.objectPath,
    bucket: data.bucket,
    expiresAt: data.expiresAt
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
    status: data.status
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
  return {
    generationId: data.generationId,
    apiProjectId: data.apiProjectId,
    status: data.status,
    hasVideo: Boolean(data.hasVideo),
    preProcessing: parseGenerationProgressStage(data.preProcessing),
    inference: parseGenerationProgressStage(data.inference),
    restoredVideo: restoredVideo ? parseGenerationProgressStage(restoredVideo) : null,
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
    bucket: data.bucket,
    mimeType: data.mimeType
  };
}

export function parseWebhookPortalResponse(data: any): WebhookPortalResponse {
  return {
    portalUrl: data.portalUrl,
    mode: data.mode ?? null,
    apiKeyId: data.apiKeyId ?? null
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

export function parseGenerationWebhookEvent(data: any): GenerationWebhookEvent {
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
    error: data.error ?? null,
    errorDetails: data.errorDetails ?? null
  };
}

export function createAudioIsolationResult(
  project: CreateProjectResponse,
  generation: CreateGenerationResponse
): AudioIsolationResult {
  return { project, generation };
}
