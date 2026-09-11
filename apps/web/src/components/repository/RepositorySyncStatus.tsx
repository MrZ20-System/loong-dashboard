import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";
import {
  fetchSyncStatus,
  startSync,
} from "../../metadata-client";
import { fetchRepositorySettings } from "../../settings-client";
import { repositoryMessages } from "./messages";

function SyncControl({ repositoryId, lookbackDays }: { repositoryId: string; lookbackDays: 7 | 30 }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [message, setMessage] = useState<{ message: LocalizedMessage; values?: MessageValues } | null>(null);
  const sync = useMutation({
    mutationFn: () => startSync(repositoryId),
    onSuccess: (accepted) => {
      setMessage({ message: repositoryMessages.syncStarted });
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
    onError: (error: Error) => setMessage({ message: repositoryMessages.syncFailed, values: { detail: error.message } }),
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
        {sync.isPending ? t(repositoryMessages.startingSync) : t(repositoryMessages.syncNow)}
      </button>
      {message && <p role={sync.isError ? "alert" : "status"}>{t(message.message, message.values)}</p>}
    </div>
  );
}

function SyncStatus({ repositoryId, lookbackDays }: { repositoryId: string; lookbackDays: 7 | 30 }) {
  const { t, formatNumber } = useI18n();
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
  if (status.isPending) return <span role="status">{t(repositoryMessages.checkingSyncStatus)}</span>;
  if (status.isError)
    return <span role="alert">{t(repositoryMessages.syncStatusUnavailable, { detail: status.error.message })}</span>;
  const pull = status.data.pullRequests;
  const issues = status.data.issues;
  const pullNeedsBootstrap = pull.watermarkUpdatedAt === null;
  const issuesNeedsBootstrap = issues.watermarkUpdatedAt === null;
  const needsBootstrap = pullNeedsBootstrap || issuesNeedsBootstrap;
  if (status.data.status === "running") {
    const runningLabel = pullNeedsBootstrap && issuesNeedsBootstrap
      ? t(repositoryMessages.initialSyncLastDays, { days: formatNumber(lookbackDays) })
      : needsBootstrap
        ? t(repositoryMessages.syncingRepositoryUpdates)
        : t(repositoryMessages.syncingLatestUpdates);
    return <span role="status">{runningLabel}</span>;
  }
  const complete = pull.status === "idle" && issues.status === "idle" && pull.lastSuccessAt !== null && issues.lastSuccessAt !== null;
  const completeAt = complete
    ? new Date(Math.min(new Date(pull.lastSuccessAt as string).getTime(), new Date(issues.lastSuccessAt as string).getTime()))
    : null;
  const age = completeAt === null ? null : Math.max(0, Math.round((Date.now() - completeAt.getTime()) / 60_000));
  const partialError = pull.lastError ?? issues.lastError;
  if (partialError !== null && partialError !== undefined)
    return <span role="alert" title={partialError}><span>{needsBootstrap ? t(repositoryMessages.initialSyncFailedLastDays, { days: formatNumber(lookbackDays) }) : t(repositoryMessages.lastSyncFailed)}</span><small> · {completeAt ? t(repositoryMessages.lastComplete, { value: age === 0 ? t(repositoryMessages.justNow) : t(repositoryMessages.minutesAgo, { minutes: formatNumber(age ?? 0) }) }) : t(repositoryMessages.noCompleteSync)}</small></span>;
  return <span role="status"><span>{needsBootstrap ? t(repositoryMessages.initialSyncLastDays, { days: formatNumber(lookbackDays) }) : t(repositoryMessages.syncIdle)}</span><small> · {completeAt ? t(repositoryMessages.synced, { value: age === 0 ? t(repositoryMessages.justNow) : t(repositoryMessages.minutesAgo, { minutes: formatNumber(age ?? 0) }) }) : t(repositoryMessages.awaitingFirstComplete)}</small></span>;
}

export function RepositorySyncStatus({ repositoryId }: { repositoryId: string }) {
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: ["repository-settings", repositoryId],
    queryFn: () => fetchRepositorySettings(repositoryId),
  });
  const lookbackDays = settings.data?.syncLookbackDays ?? 30;
  return (
    <div className="topbar-sync" aria-label={t(repositoryMessages.syncStatus, { repositoryId })}>
      <span className="status-dot" aria-hidden="true" />
      <div className="sync-status">
        <SyncStatus repositoryId={repositoryId} lookbackDays={lookbackDays} />
      </div>
      <SyncControl repositoryId={repositoryId} lookbackDays={lookbackDays} />
    </div>
  );
}
