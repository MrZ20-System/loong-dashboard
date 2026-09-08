import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchSyncStatus,
  startSync,
} from "../../metadata-client";

function SyncControl({ repositoryId }: { repositoryId: string }) {
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

function SyncStatus({ repositoryId }: { repositoryId: string }) {
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
  if (status.data.status === "running")
    return <span role="status">Sync in progress…</span>;
  if (status.data.status === "failed")
    return (
      <span role="alert">Last sync failed. Existing rows remain available.</span>
    );
  return <span role="status">Sync idle</span>;
}

export function RepositorySyncStatus({ repositoryId }: { repositoryId: string }) {
  return (
    <div className="topbar-sync" aria-label={`${repositoryId} sync status`}>
      <span className="status-dot" aria-hidden="true" />
      <div className="sync-status">
        <SyncStatus repositoryId={repositoryId} />
      </div>
      <SyncControl repositoryId={repositoryId} />
    </div>
  );
}
