import {
  archivePreviewRequestSchema,
  archivePreviewResponseSchema,
  archiveRunCreateSchema,
  maintenanceRunAcceptedSchema,
  maintenanceRunParamsSchema,
  maintenanceRunSchema,
  maintenanceRunsResponseSchema,
  restoreMetadataResponseSchema,
  runtimeHistoryPurgePreviewRequestSchema,
  runtimeHistoryPurgePreviewResponseSchema,
  runtimeHistoryPurgeRunCreateSchema,
  type ArchivePreviewRequest,
  type ArchiveRunCreate,
  type ArchivePreviewResponse,
  type MaintenanceRun,
  type MaintenanceRunAccepted,
  type MaintenanceRunsResponse,
  type RestoreMetadataResponse,
  type RuntimeHistoryPurgePreviewRequest,
  type RuntimeHistoryPurgePreviewResponse,
  type RuntimeHistoryPurgeRunCreate,
} from "@loongboard/contracts";

import { request } from "./metadata-client";

function repositoryPath(repositoryId: string): string {
  return encodeURIComponent(repositoryId);
}

export function previewRepositoryMaintenance(
  repositoryId: string,
  input: ArchivePreviewRequest,
): Promise<ArchivePreviewResponse> {
  const body = archivePreviewRequestSchema.parse(input);
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/maintenance/preview`,
    archivePreviewResponseSchema,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

export function startRepositoryMaintenance(
  repositoryId: string,
  input: ArchiveRunCreate,
): Promise<MaintenanceRunAccepted> {
  const body = archiveRunCreateSchema.parse(input);
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/maintenance`,
    maintenanceRunAcceptedSchema,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

export function previewRuntimeHistoryPurge(
  repositoryId: string,
  input: RuntimeHistoryPurgePreviewRequest = {},
): Promise<RuntimeHistoryPurgePreviewResponse> {
  const body = runtimeHistoryPurgePreviewRequestSchema.parse(input);
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/maintenance/runtime-history/preview`,
    runtimeHistoryPurgePreviewResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function startRuntimeHistoryPurge(
  repositoryId: string,
  input: RuntimeHistoryPurgeRunCreate = {},
): Promise<MaintenanceRunAccepted> {
  const body = runtimeHistoryPurgeRunCreateSchema.parse(input);
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/maintenance/runtime-history`,
    maintenanceRunAcceptedSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function fetchMaintenanceRuns(
  repositoryId: string,
): Promise<MaintenanceRunsResponse> {
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/maintenance`,
    maintenanceRunsResponseSchema,
  );
}

export function fetchMaintenanceRun(
  repositoryId: string,
  runId: string,
): Promise<MaintenanceRun> {
  const params = maintenanceRunParamsSchema.parse({ repositoryId, runId });
  return request(
    `/api/repositories/${repositoryPath(params.repositoryId)}/maintenance/${encodeURIComponent(params.runId)}`,
    maintenanceRunSchema,
  );
}

export function restorePullRequestMetadata(
  repositoryId: string,
  number: number,
): Promise<RestoreMetadataResponse> {
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/pulls/${number}/restore`,
    restoreMetadataResponseSchema,
    { method: "POST" },
  );
}

export function restoreIssueMetadata(
  repositoryId: string,
  number: number,
): Promise<RestoreMetadataResponse> {
  return request(
    `/api/repositories/${repositoryPath(repositoryId)}/issues/${number}/restore`,
    restoreMetadataResponseSchema,
    { method: "POST" },
  );
}
