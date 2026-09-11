import {
  historyResponseSchema,
  syncRequestSchema,
  syncRunAcceptedSchema,
  syncRunSchema,
  syncRunsResponseSchema,
  type HistoryResponse,
  type HistorySettingsUpdate,
  type SyncRun,
  type SyncRunAccepted,
  type SyncRunsResponse,
} from "@loongboard/contracts";
import { request } from "./metadata-client";

function repositoryUrl(repositoryId: string, suffix: string): string {
  return `/api/repositories/${encodeURIComponent(repositoryId)}${suffix}`;
}

export function fetchSyncRuns(
  repositoryId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<SyncRunsResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  return request(
    `${repositoryUrl(repositoryId, "/sync-runs")}?${query.toString()}`,
    syncRunsResponseSchema,
    { signal },
  );
}

export function fetchSyncRun(
  repositoryId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<SyncRun> {
  return request(
    repositoryUrl(repositoryId, `/sync-runs/${encodeURIComponent(runId)}`),
    syncRunSchema,
    { signal },
  );
}

export function fetchSyncHistory(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  return request(repositoryUrl(repositoryId, "/sync-history"), historyResponseSchema, { signal });
}

export function updateSyncHistory(
  repositoryId: string,
  update: HistorySettingsUpdate,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  const body = syncRequestSchema.safeParse({ kind: "history", targetDate: update.targetDate ?? undefined });
  // The history settings route has its own contract; this small guard keeps a
  // date selected by the UI from ever becoming an arbitrary sync request.
  if (update.targetDate !== undefined && !body.success) {
    throw new Error("Invalid history target date");
  }
  return request(repositoryUrl(repositoryId, "/sync-history"), historyResponseSchema, {
    method: "PUT",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

const noContentSchema = { parse: (_value: unknown): undefined => undefined };

export function pauseSyncHistory(repositoryId: string, signal?: AbortSignal): Promise<void> {
  return request(repositoryUrl(repositoryId, "/sync-history/pause"), noContentSchema, {
    method: "POST",
    signal,
  });
}

export function continueSyncHistory(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<SyncRunAccepted> {
  return request(repositoryUrl(repositoryId, "/sync-history/continue"), syncRunAcceptedSchema, {
    method: "POST",
    signal,
  });
}

export function startHistorySync(
  repositoryId: string,
  targetDate: string | null,
  signal?: AbortSignal,
): Promise<SyncRunAccepted> {
  const body = targetDate === null
    ? { kind: "history" as const }
    : { kind: "history" as const, targetDate };
  return request(repositoryUrl(repositoryId, "/sync"), syncRunAcceptedSchema, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchSinglePullRequest(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<SyncRunAccepted> {
  return request(
    repositoryUrl(repositoryId, `/pulls/${number}/fetch`),
    syncRunAcceptedSchema,
    {
      method: "POST",
      signal,
    },
  );
}
