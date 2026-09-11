import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SyncRun } from "@loongboard/contracts";
import { useRepositories } from "../../app/hooks";
import { fetchSyncStatus, startSync } from "../../metadata-client";
import {
  continueSyncHistory,
  fetchSyncHistory,
  fetchSyncRun,
  fetchSyncRuns,
  pauseSyncHistory,
  startHistorySync,
  updateSyncHistory,
} from "../../sync-client";
import { shiftDay, todayValue } from "../../components/filters/date-utils";
import {
  cleanupRepositoryWorktrees,
  fetchRepositorySettings,
  updateRepositorySettings,
} from "../../settings-client";
import { RepositoryRetentionSection } from "./RepositoryRetentionSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";

const activeRunStatuses = new Set<SyncRun["status"]>(["queued", "running"]);

function isActiveRun(run: SyncRun | undefined): boolean {
  return run !== undefined && activeRunStatuses.has(run.status);
}

function syncRunTarget(run: SyncRun): string {
  const selector = run.selector;
  const targetDate = selector.targetDate;
  if (typeof targetDate === "string") return targetDate;
  const from = selector.from;
  const to = selector.to;
  if (typeof from === "string" && typeof to === "string") return `${from} – ${to}`;
  if (typeof selector.number === "number") return `PR #${selector.number}`;
  return run.kind === "forward" ? "Forward watermark" : "Target not specified";
}

function syncRunDuration(run: SyncRun): string {
  if (run.startedAt === null || run.finishedAt === null) return "In progress";
  const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(elapsed) ? `${Math.max(0, Math.round(elapsed / 1000))}s` : "Duration unavailable";
}

export function HistorySyncSection({ repositoryId }: { repositoryId: string }) {
  const client = useQueryClient();
  const history = useQuery({
    queryKey: ["sync-history", repositoryId],
    queryFn: ({ signal }) => fetchSyncHistory(repositoryId, signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const recentRuns = useQuery({
    queryKey: ["sync-runs", repositoryId],
    queryFn: ({ signal }) => fetchSyncRuns(repositoryId, 20, signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRun = useQuery({
    queryKey: ["sync-run", repositoryId, activeRunId],
    enabled: activeRunId !== null,
    queryFn: ({ signal }) => fetchSyncRun(repositoryId, activeRunId as string, signal),
    refetchInterval: (query) => {
      const run = query.state.data;
      return activeRunId !== null && (run === undefined || isActiveRun(run)) ? 1_000 : false;
    },
  });
  const pullHistory = history.data?.settings.find(
    (item) => item.entityKind === "pull_request",
  ) ?? history.data?.settings[0];
  const effectiveTargetDate = targetDate ?? pullHistory?.targetDate ?? todayValue();
  const progress = pullHistory?.oldestCoveredDay
    ? `Covered through ${pullHistory.oldestCoveredDay}`
    : "No historical coverage yet";

  useEffect(() => {
    const run = activeRun.data;
    if (run === undefined || isActiveRun(run)) return;
    void client.invalidateQueries({ queryKey: ["sync-history", repositoryId] });
    void client.invalidateQueries({ queryKey: ["sync-runs", repositoryId] });
  }, [activeRun.data, client, repositoryId]);

  const start = useMutation({
    mutationFn: async (nextTargetDate: string) => {
      await updateSyncHistory(repositoryId, { enabled: true, targetDate: nextTargetDate });
      return startHistorySync(repositoryId, nextTargetDate);
    },
    onSuccess: (accepted) => {
      setTargetDate(null);
      setActiveRunId(accepted.syncRunId);
      void client.invalidateQueries({ queryKey: ["sync-history", repositoryId] });
      void client.invalidateQueries({ queryKey: ["sync-runs", repositoryId] });
    },
  });
  const pause = useMutation({
    mutationFn: () => pauseSyncHistory(repositoryId),
    onSuccess: () => {
      setActiveRunId(null);
      void client.invalidateQueries({ queryKey: ["sync-history", repositoryId] });
    },
  });
  const continueRun = useMutation({
    mutationFn: () => continueSyncHistory(repositoryId),
    onSuccess: (accepted) => {
      setActiveRunId(accepted.syncRunId);
      void client.invalidateQueries({ queryKey: ["sync-history", repositoryId] });
      void client.invalidateQueries({ queryKey: ["sync-runs", repositoryId] });
    },
  });
  const actionError = start.error ?? pause.error ?? continueRun.error;
  const status = pullHistory?.status ?? "idle";
  const displayedError = activeRun.data?.error ?? pullHistory?.lastError ?? null;

  return (
    <section className="settings-subsection history-sync-section" aria-labelledby={`history-${repositoryId}`}>
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">Historical PR coverage</p>
          <h4 id={`history-${repositoryId}`}>History</h4>
          <p className="settings-muted">Set a historical target and keep backfilling in bounded runs until coverage reaches it. Forward sync and history keep separate watermarks.</p>
        </div>
        <span className={`status-pill status-pill--${status}`}>{status}</span>
      </header>
      {history.isError && <ErrorText error={history.error} />}
      {recentRuns.isError && <ErrorText error={recentRuns.error} />}
      {actionError && <ErrorText error={actionError} />}
      <div className="settings-history-summary">
        <div><span>Target date</span><strong>{effectiveTargetDate}</strong></div>
        <div><span>Oldest covered</span><strong>{pullHistory?.oldestCoveredDay ?? "Not covered"}</strong></div>
        <div><span>Progress</span><strong>{progress}</strong></div>
        <div><span>Last error</span><strong>{displayedError ?? "None"}</strong></div>
      </div>
      <div className="settings-form-row history-sync-controls">
        <label>Backfill through<input aria-label="History target date" type="date" value={effectiveTargetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -6))} disabled={start.isPending || continueRun.isPending}>Backfill 7 days</button>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -29))} disabled={start.isPending || continueRun.isPending}>Backfill 30 days</button>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -89))} disabled={start.isPending || continueRun.isPending}>Backfill 90 days</button>
        <button type="button" className="button-primary" onClick={() => start.mutate(effectiveTargetDate)} disabled={start.isPending || pause.isPending}>{start.isPending ? "Starting…" : "Enable and start"}</button>
        {status === "paused" || status === "failed" ? <button type="button" onClick={() => continueRun.mutate()} disabled={continueRun.isPending}>{continueRun.isPending ? "Continuing…" : "Continue"}</button> : <button type="button" onClick={() => pause.mutate()} disabled={pause.isPending || status === "idle"}>{pause.isPending ? "Pausing…" : "Pause"}</button>}
      </div>
      {activeRun.data && isActiveRun(activeRun.data) && <p role="status" className="settings-message">This history run is {activeRun.data.status}; only this run is being checked.</p>}
      {activeRun.data && !isActiveRun(activeRun.data) && activeRun.data.error && <p role="alert" className="settings-error">History run failed: {activeRun.data.error}</p>}
      <section className="settings-history-runs" aria-labelledby={`recent-syncs-${repositoryId}`}>
        <h5 id={`recent-syncs-${repositoryId}`}>Recent syncs</h5>
        {recentRuns.isPending ? <p role="status">Loading recent syncs…</p> : recentRuns.data?.items.length === 0 ? <p className="settings-muted">No sync runs yet.</p> : (
          <ul>
            {(recentRuns.data?.items ?? []).map((run) => (
              <li key={run.syncRunId}>
                <span><strong>{run.kind === "fetch_pr" ? "Fetch PR" : run.kind === "history" ? "History" : "Forward"}</strong> · target {syncRunTarget(run)} · requested {new Date(run.requestedAt).toLocaleString()}</span>
                <span className={`status-pill status-pill--${run.status}`}>{run.status}</span>
                <span>{run.itemsSeen} processed · {run.itemsWritten} changed · started {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"} · finished {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"} · {syncRunDuration(run)}</span>
                {run.error && <span className="settings-error">{run.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface RepositorySettingsCardProps {
  repositoryId: string;
  name: string;
  githubOwner: string;
  githubName: string;
  localPath: string;
  pullRequestCount?: number;
  issueCount?: number;
}

function RepositorySettingsCard({
  repositoryId,
  name,
  githubOwner,
  githubName,
  localPath,
  pullRequestCount,
  issueCount,
}: RepositorySettingsCardProps) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["repository-settings", repositoryId], queryFn: () => fetchRepositorySettings(repositoryId) });
  const sync = useQuery({ queryKey: ["sync", repositoryId], queryFn: ({ signal }) => fetchSyncStatus(repositoryId, signal), refetchInterval: 5_000 });
  const [frequency, setFrequency] = useState(60);
  const [automatic, setAutomatic] = useState(true);
  const [configuredSlots, setConfiguredSlots] = useState(1);
  const [idleCleanupTtlHours, setIdleCleanupTtlHours] = useState(24);
  const save = useMutation({ mutationFn: () => updateRepositorySettings(repositoryId, { automaticSync: automatic, syncFrequencyMinutes: frequency, worktrees: { configuredSlots, idleCleanupTtlHours } }), onSuccess: (data) => { client.setQueryData(["repository-settings", repositoryId], data); } });
  const cleanup = useMutation({ mutationFn: () => cleanupRepositoryWorktrees(repositoryId), onSuccess: (data) => { client.setQueryData(["repository-settings", repositoryId], data); } });
  const run = useMutation({ mutationFn: () => startSync(repositoryId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["sync", repositoryId] }); } });
  const state = settings.data;
  useEffect(() => {
    if (state === undefined) return;
    setAutomatic(state.automaticSync);
    setFrequency(state.syncFrequencyMinutes);
    setConfiguredSlots(state.worktrees?.configuredSlots ?? 1);
    setIdleCleanupTtlHours(state.worktrees?.idleCleanupTtlHours ?? 24);
  }, [state?.automaticSync, state?.syncFrequencyMinutes, state?.worktrees?.configuredSlots, state?.worktrees?.idleCleanupTtlHours]);
  const stream = sync.data?.pullRequests;
  const pullSuccess = stream?.lastSuccessAt ?? null;
  const issueSuccess = sync.data?.issues.lastSuccessAt ?? null;
  const latest = pullSuccess !== null && issueSuccess !== null
    ? (new Date(pullSuccess).getTime() <= new Date(issueSuccess).getTime() ? pullSuccess : issueSuccess)
    : pullSuccess ?? issueSuccess ?? state?.lastSyncAt ?? null;
  const localCounts = pullRequestCount !== undefined || issueCount !== undefined
    ? `${pullRequestCount ?? "—"} PR · ${issueCount ?? "—"} issues`
    : "Unavailable";

  return <article className="settings-card repository-settings-card">
    <header className="settings-card__header"><div><p className="eyebrow">Repository</p><h3>{name}</h3><p className="settings-muted">{repositoryId}</p></div><span className={`status-pill status-pill--${sync.data?.status ?? "unknown"}`}>{sync.data?.status ?? "unknown"}</span></header>
    <dl className="settings-details"><div><dt>GitHub repository</dt><dd>{githubOwner}/{githubName}</dd></div><div><dt>Local path</dt><dd>{localPath}</dd></div><div><dt>Repository key</dt><dd>{repositoryId}</dd></div></dl><div className="settings-metrics"><div><span>Last successful sync</span><strong>{latest ? new Date(latest).toLocaleString() : "No successful sync"}</strong></div><div><span>Next automatic sync</span><strong>{state?.nextSyncAt ? new Date(state.nextSyncAt).toLocaleString() : "Not scheduled"}</strong></div><div><span>Recent error</span><strong>{stream?.lastError ?? sync.data?.issues.lastError ?? "None"}</strong></div></div>
    <p className="settings-sync-scope"><strong>Live sync follows the forward watermark for new and changed PRs and issues.</strong> Historical coverage is configured below in History and continues toward its selected target.<br /><span>Stored locally: {localCounts}</span></p>
    {settings.isError && <ErrorText error={settings.error} />}
    {sync.isError && <ErrorText error={sync.error} />}
    {save.isError && <ErrorText error={save.error} />}
    {run.isError && <ErrorText error={run.error} />}
    {save.isSuccess && <p role="status" className="settings-message">Repository sync settings saved.</p>}
    <div className="settings-form-row"><SettingsSwitch label="Automatic sync" checked={automatic} onChange={setAutomatic} /><label>Every <select value={frequency} onChange={(event) => setFrequency(Number(event.target.value))}><option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label><button type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save</button><button type="button" className="button-primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Starting…" : "Sync now"}</button></div>
    <section className="settings-subsection" aria-labelledby={`worktrees-${repositoryId}`}><header className="settings-card__header"><div><p className="eyebrow">Workspace isolation</p><h4 id={`worktrees-${repositoryId}`}>Worktrees</h4><p className="settings-muted">Capacity is per repository and does not limit Agent global concurrency.</p></div></header><div className="settings-grid"><label>Maximum slots<select value={configuredSlots} onChange={(event) => setConfiguredSlots(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count}</option>)}</select></label><label>Idle cleanup TTL<select value={idleCleanupTtlHours} onChange={(event) => setIdleCleanupTtlHours(Number(event.target.value))}><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option><option value={720}>30 days</option></select></label></div><dl className="settings-details"><div><dt>Configured / physical</dt><dd>{state?.worktrees?.configuredSlots ?? configuredSlots} / {state?.worktrees?.physicalSlots ?? 0}</dd></div><div><dt>Active / idle</dt><dd>{state?.worktrees?.active ?? 0} / {state?.worktrees?.idle ?? 0}</dd></div><div><dt>Dirty</dt><dd>{state?.worktrees?.dirty ?? 0}</dd></div><div><dt>Pending retirement</dt><dd>{state?.worktrees?.pendingRetirement ?? 0}</dd></div></dl><div className="settings-form-row"><button type="button" onClick={() => cleanup.mutate()} disabled={cleanup.isPending}>{cleanup.isPending ? "Cleaning…" : "Clean unused now"}</button></div>{cleanup.isError && <ErrorText error={cleanup.error} />}</section>
    <HistorySyncSection repositoryId={repositoryId} />
    <RepositoryRetentionSection repositoryId={repositoryId} />
    {run.isPending && <p role="status" className="settings-message">Sync started. Fetching recent history for new repositories and updates for existing ones.</p>}
    {run.isSuccess && !run.isPending && <p role="status" className="settings-message">Sync started.</p>}
  </article>;
}

export function RepositorySettingsSection() {
  const repositories = useRepositories();
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError) return <ErrorText error={repositories.error} />;
  return <div className="settings-stack">{repositories.data.items.map((repository) => <RepositorySettingsCard key={repository.id} repositoryId={repository.id} name={repository.displayName} githubOwner={repository.githubOwner} githubName={repository.githubName} localPath={repository.localPath} pullRequestCount={repository.pullRequestCount} issueCount={repository.issueCount} />)}{repositories.data.items.length === 0 && <p role="status">No configured repositories.</p>}</div>;
}

export { RepositorySettingsSection as RepositoriesSettings };
