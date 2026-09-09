import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchSyncStatus,
  startSync,
} from "../../metadata-client";
import { fetchRepositorySettings } from "../../settings-client";

function SyncControl({ repositoryId, lookbackDays }: { repositoryId: string; lookbackDays: 7 | 30 }) {
  const client = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const sync = useMutation({
    mutationFn: () => startSync(repositoryId),
    onSuccess: (accepted) => {
      setMessage("Sync started.");
      const statusKey = ["sync", repositoryId] as const;
      const attemptKey = ["sync-attempt", repositoryId] as const;
      const statusState = client.getQueryState(statusKey);
      client.setQueryData(attemptKey, {
        syncRunId: accepted.syncRunId,
        statusDataUpdatedAt:
          statusState?.data === undefined ? null : statusState.dataUpdatedAt,
        waitForStatusRefresh: true,
        statusRefreshRequestedAt: null,
      });
    },
    onError: (error: Error) => setMessage(`Sync failed: ${error.message}`),
  });
  return (
    <div className="sync-control">
      <button
        type="button"
        onClick={() => {
          setMessage(null);
          sync.mutate();
        }}
        disabled={sync.isPending}
      >
        {sync.isPending ? "Starting sync…" : "Sync now"}
      </button>
      {message && <p role={sync.isError ? "alert" : "status"}>{message}</p>}
    </div>
  );
}

function SyncStatus({ repositoryId, lookbackDays }: { repositoryId: string; lookbackDays: 7 | 30 }) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["sync", repositoryId],
    queryFn: ({ signal }) => fetchSyncStatus(repositoryId, signal),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1000 : false,
  });
  const accepted = useQuery<{
    syncRunId: string;
    statusDataUpdatedAt: number | null;
    waitForStatusRefresh: boolean;
    statusRefreshRequestedAt: number | null;
  } | null>({
    queryKey: ["sync-attempt", repositoryId],
    queryFn: async () => null,
    enabled: false,
  });
  const acceptedRunId = accepted.data?.syncRunId;
  const previousStreams = useRef<{
    pullRequests: "idle" | "running" | "failed";
    issues: "idle" | "running" | "failed";
  } | null>(null);
  const previousRepositoryId = useRef(repositoryId);
  const firstStatusEffect = useRef(true);
  useEffect(() => {
    const isFirstStatusEffect = firstStatusEffect.current;
    firstStatusEffect.current = false;
    let repositoryChanged = false;
    if (previousRepositoryId.current !== repositoryId) {
      previousRepositoryId.current = repositoryId;
      previousStreams.current = null;
      repositoryChanged = true;
    }
    if (!status.data) return;
    const streams = {
      pullRequests: status.data.pullRequests,
      issues: status.data.issues,
    };
    const previous = previousStreams.current;
    const handledKey = ["sync-handled", repositoryId] as const;
    let handled = client.getQueryData<{
      syncRunId: string;
      pullRequests: boolean;
      issues: boolean;
    }>(handledKey);
    const isNewAttempt =
      acceptedRunId !== null && acceptedRunId !== handled?.syncRunId;
    if (isNewAttempt && acceptedRunId) {
      handled = { syncRunId: acceptedRunId, pullRequests: false, issues: false };
      client.setQueryData(handledKey, handled);
    }
    let acceptedAttempt = accepted.data;
    if (acceptedAttempt?.waitForStatusRefresh) {
      if (acceptedAttempt.statusDataUpdatedAt === null) {
        acceptedAttempt = {
          ...acceptedAttempt,
          statusDataUpdatedAt: status.dataUpdatedAt,
        };
        client.setQueryData(["sync-attempt", repositoryId], acceptedAttempt);
      } else if (status.dataUpdatedAt > acceptedAttempt.statusDataUpdatedAt) {
        acceptedAttempt = {
          ...acceptedAttempt,
          waitForStatusRefresh: false,
          statusRefreshRequestedAt: null,
        };
        client.setQueryData(["sync-attempt", repositoryId], acceptedAttempt);
      }
      if (acceptedAttempt.waitForStatusRefresh) {
        const shouldRefresh =
          isFirstStatusEffect ||
          repositoryChanged ||
          acceptedAttempt.statusRefreshRequestedAt !== status.dataUpdatedAt;
        if (shouldRefresh) {
          const requestedAttempt = {
            ...acceptedAttempt,
            statusRefreshRequestedAt: status.dataUpdatedAt,
          };
          client.setQueryData(["sync-attempt", repositoryId], requestedAttempt);
          void client.refetchQueries({ queryKey: ["sync", repositoryId] });
        }
        previousStreams.current = {
          pullRequests: streams.pullRequests.status,
          issues: streams.issues.status,
        };
        return;
      }
    }
    const acceptedStatusReady =
      acceptedAttempt?.waitForStatusRefresh === false &&
      (acceptedAttempt.statusDataUpdatedAt === null ||
        status.dataUpdatedAt > acceptedAttempt.statusDataUpdatedAt);
    for (const [streamName, stream] of Object.entries(streams) as Array<
      ["pullRequests" | "issues", typeof streams.pullRequests]
    >) {
      if (!handled || handled[streamName]) continue;
      const reachedSuccessfulTerminal =
        stream.status === "idle" &&
        acceptedRunId !== null &&
        acceptedStatusReady &&
        ((acceptedAttempt !== null &&
          acceptedAttempt !== undefined &&
          acceptedAttempt.statusDataUpdatedAt !== null) ||
          isNewAttempt ||
          previous?.[streamName] === "running");
      if (reachedSuccessfulTerminal) {
        handled = { ...handled, [streamName]: true };
        client.setQueryData(handledKey, handled);
        const streamKind = streamName === "pullRequests" ? "pulls" : "issues";
        void client.invalidateQueries({
          queryKey: ["metadata", repositoryId, streamKind],
        });
        void client.invalidateQueries({ queryKey: ["repositories"] });
      }
    }
    previousStreams.current = {
      pullRequests: streams.pullRequests.status,
      issues: streams.issues.status,
    };
  }, [
    accepted.data,
    acceptedRunId,
    client,
    repositoryId,
    status.data,
    status.dataUpdatedAt,
  ]);
  if (status.isPending) return <span role="status">Checking sync status…</span>;
  if (status.isError)
    return <span role="alert">Sync status unavailable: {status.error.message}</span>;
  const pull = status.data.pullRequests;
  const issues = status.data.issues;
  const pullNeedsBootstrap = pull.watermarkUpdatedAt === null;
  const issuesNeedsBootstrap = issues.watermarkUpdatedAt === null;
  const needsBootstrap = pullNeedsBootstrap || issuesNeedsBootstrap;
  if (status.data.status === "running") {
    const runningLabel = pullNeedsBootstrap && issuesNeedsBootstrap
      ? `Initial sync · last ${lookbackDays} days`
      : needsBootstrap
        ? "Syncing repository updates…"
        : "Syncing latest updates…";
    return <span role="status">{runningLabel}</span>;
  }
  const complete = pull.status === "idle" && issues.status === "idle" && pull.lastSuccessAt !== null && issues.lastSuccessAt !== null;
  const completeAt = complete
    ? new Date(Math.min(new Date(pull.lastSuccessAt as string).getTime(), new Date(issues.lastSuccessAt as string).getTime()))
    : null;
  const age = completeAt === null ? null : Math.max(0, Math.round((Date.now() - completeAt.getTime()) / 60_000));
  const partialError = pull.lastError ?? issues.lastError;
  if (partialError !== null && partialError !== undefined)
    return <span role="alert" title={partialError}><span>{needsBootstrap ? `Initial sync failed · last ${lookbackDays} days` : "Last sync failed"}</span><small> · {completeAt ? `last complete ${age === 0 ? "just now" : `${age}m ago`}` : "no complete sync"}</small></span>;
  return <span role="status"><span>{needsBootstrap ? `Initial sync · last ${lookbackDays} days` : "Sync idle"}</span><small> · {completeAt ? `Synced ${age === 0 ? "just now" : `${age}m ago`}` : "Awaiting first complete sync"}</small></span>;
}

export function RepositorySyncStatus({ repositoryId }: { repositoryId: string }) {
  const settings = useQuery({
    queryKey: ["repository-settings", repositoryId],
    queryFn: () => fetchRepositorySettings(repositoryId),
  });
  const lookbackDays = settings.data?.syncLookbackDays ?? 30;
  return (
    <div className="topbar-sync" aria-label={`${repositoryId} sync status`}>
      <span className="status-dot" aria-hidden="true" />
      <div className="sync-status">
        <SyncStatus repositoryId={repositoryId} lookbackDays={lookbackDays} />
      </div>
      <SyncControl repositoryId={repositoryId} lookbackDays={lookbackDays} />
    </div>
  );
}
