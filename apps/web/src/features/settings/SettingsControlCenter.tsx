import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  AgentRuntimeModelCapability,
  SyncRun,
} from "@loongboard/contracts";
import { Link } from "react-router-dom";
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
  fetchAgentRuntimeSettings,
  fetchGitHubIntegration,
  fetchRepositorySettings,
  removeGitHubToken,
  saveGitHubToken,
  saveProviderSecret,
  updateAgentRuntimeSettings,
  updateRepositorySettings,
  cleanupRepositoryWorktrees,
  verifyGitHubIntegration,
  type AgentRuntimeSettings,
  type GitHubIntegration,
  fetchKnowledgeCheckpointSettings,
  updateKnowledgeCheckpointSettings,
  runKnowledgeCheckpoint,
  pushKnowledgeCheckpoint,
  type KnowledgeCheckpointSettings,
  fetchCodeBackupSettings,
  updateCodeBackupSettings,
  runCodeBackupCheckpoint,
  pushCodeBackup,
  type CodeBackupSettings,
  fetchAgentArchiveSettings,
  updateAgentArchiveSettings,
  runAgentArchiveExport,
  pushAgentArchive,
  type AgentArchiveSettings,
} from "../../settings-client";
import { SettingsSwitch } from "./SettingsSwitch";

function ErrorText({ error }: { error: unknown }) {
  return <p role="alert" className="settings-error">{error instanceof Error ? error.message : String(error)}</p>;
}

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

function RepositorySettingsCard({ repositoryId, name, githubOwner, githubName, localPath, pullRequestCount, issueCount }: { repositoryId: string; name: string; githubOwner: string; githubName: string; localPath: string; pullRequestCount?: number; issueCount?: number }) {
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
    {run.isPending && <p role="status" className="settings-message">Sync started. Fetching recent history for new repositories and updates for existing ones.</p>}
    {run.isSuccess && !run.isPending && <p role="status" className="settings-message">Sync started.</p>}
  </article>;
}

function RepositoriesSettings() {
  const repositories = useRepositories();
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError) return <ErrorText error={repositories.error} />;
  return <div className="settings-stack">{repositories.data.items.map((repository) => <RepositorySettingsCard key={repository.id} repositoryId={repository.id} name={repository.displayName} githubOwner={repository.githubOwner} githubName={repository.githubName} localPath={repository.localPath} pullRequestCount={repository.pullRequestCount} issueCount={repository.issueCount} />)}{repositories.data.items.length === 0 && <p role="status">No configured repositories.</p>}</div>;
}

function IntegrationsSettings() {
  const client = useQueryClient();
  const integration = useQuery({ queryKey: ["github-integration"], queryFn: fetchGitHubIntegration });
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => saveGitHubToken(token), onSuccess: (data) => { setToken(""); setMessage("Token saved securely. The secret is never displayed."); client.setQueryData(["github-integration"], data); }, onError: (error: Error) => setMessage(error.message) });
  const verify = useMutation({ mutationFn: verifyGitHubIntegration, onSuccess: (data) => { setMessage("GitHub connection verified."); client.setQueryData(["github-integration"], data); }, onError: (error: Error) => setMessage(error.message) });
  const remove = useMutation({ mutationFn: removeGitHubToken, onSuccess: () => { setMessage("GitHub credential removed."); void client.invalidateQueries({ queryKey: ["github-integration"] }); }, onError: (error: Error) => setMessage(error.message) });
  const data = integration.data as GitHubIntegration | undefined;
  return <div className="settings-stack"><section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">GitHub</p><h3>GitHub integration</h3></div><span className={`status-pill status-pill--${data?.configured ? "ok" : "unknown"}`}>{data?.configured ? "Configured" : "Not configured"}</span></header>{integration.isError && <ErrorText error={integration.error} />}<dl className="settings-details"><div><dt>Credential source</dt><dd>{data?.source ?? "—"}</dd></div><div><dt>Verified account</dt><dd>{data?.account?.login ?? "—"}</dd></div><div><dt>REST quota</dt><dd>{data?.rest?.remaining !== undefined ? `${data.rest.remaining} / ${data.rest.limit ?? "?"}` : "—"}</dd></div><div><dt>GraphQL quota</dt><dd>{data?.graphql?.remaining !== undefined ? `${data.graphql.remaining} / ${data.graphql.limit ?? "?"}` : "—"}</dd></div><div><dt>Rate limit reset</dt><dd>{data?.rest?.resetAt ? new Date(data.rest.resetAt).toLocaleString() : "—"}</dd></div><div><dt>Last verified</dt><dd>{data?.lastVerifiedAt ? new Date(data.lastVerifiedAt).toLocaleString() : "—"}</dd></div></dl><form className="secret-form" onSubmit={(event) => { event.preventDefault(); if (token.trim()) save.mutate(); }}><label> {data?.configured ? "Replace token" : "Personal access token"}<input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={data?.configured ? "Enter a replacement token" : "Token is never echoed"} /></label><div className="settings-form-row"><button type="submit" className="button-primary" disabled={!token.trim() || save.isPending}>Save credential</button><button type="button" onClick={() => verify.mutate()} disabled={!data?.configured || verify.isPending}>Test connection</button><button type="button" className="button-danger" onClick={() => remove.mutate()} disabled={!data?.configured || remove.isPending}>Remove</button></div></form>{message && <p role={message.includes("failed") || message.includes("HTTP") ? "alert" : "status"} className="settings-message">{message}</p>}</section></div>;
}

function AgentSettings() {
  const client = useQueryClient();
  const runtime = useQuery({ queryKey: ["agent-runtime-settings"], queryFn: fetchAgentRuntimeSettings });
  const [draft, setDraft] = useState<Partial<AgentRuntimeSettings>>({});
  const [provider, setProvider] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => updateAgentRuntimeSettings({ defaultProvider: draft.defaultProvider, defaultModel: draft.defaultModel, defaultReasoning: draft.defaultReasoning, retentionMinutes: draft.retentionMinutes }), onSuccess: (data) => { client.setQueryData(["agent-runtime-settings"], data); setMessage("Agent defaults saved."); }, onError: (error: Error) => setMessage(error.message) });
  const secretSave = useMutation({ mutationFn: () => saveProviderSecret(provider, secret), onSuccess: () => { setSecret(""); setMessage("Provider secret saved. The secret is never echoed."); }, onError: (error: Error) => setMessage(error.message) });
  const data = { ...runtime.data, ...draft };
  const capabilities = runtime.data?.capabilities;
  const modelOptions = capabilities?.models ?? [];
  const selectedModel = modelOptions.find((model) => model.id === data.defaultModel);
  const providerOptions = Array.from(new Set([...(capabilities?.providers ?? []).map((provider) => provider.id), ...modelOptions.map((model) => model.provider), ...(data.defaultProvider ? [data.defaultProvider] : [])]));
  const reasoningOptions = Array.from(new Set([...selectedModel?.reasoningEfforts ?? capabilities?.reasoning ?? [], ...(data.defaultReasoning ? [data.defaultReasoning] : [])]));
  const retentionOptions = Array.from(new Set([30, 60, 120, 240, 0, ...(data.retentionMinutes !== undefined ? [data.retentionMinutes] : [])]));
  const retention = data.retentionMinutes ?? 120;
  return <div className="settings-stack"><section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">DSH runtime</p><h3>Agent defaults</h3></div><span className={`status-pill status-pill--${data.connected === false ? "error" : "ok"}`}>{data.status ?? (data.connected === false ? "Offline" : "Ready")}</span></header>{runtime.isError && <ErrorText error={runtime.error} />}<dl className="settings-details"><div><dt>Runtime version</dt><dd>{data.version ?? "—"}</dd></div><div><dt>Profile</dt><dd>{data.profile ?? "—"}</dd></div></dl><div className="settings-grid"><label>Default provider<select value={data.defaultProvider ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultProvider: event.target.value || null }))}><option value="">Runtime default</option>{providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Default model<select value={data.defaultModel ?? ""} onChange={(event) => { const nextModel = modelOptions.find((item) => item.id === event.target.value); setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultModel: event.target.value || null, ...(nextModel ? { defaultProvider: nextModel.provider } : {}) })); }}><option value="">Runtime default</option>{data.defaultModel && selectedModel === undefined && <option value={data.defaultModel}>{data.defaultModel} · saved</option>}{modelOptions.map((model: AgentRuntimeModelCapability) => <option key={model.id} value={model.id}>{model.label ?? model.id} · {model.provider}</option>)}</select></label><label>Default reasoning<select value={data.defaultReasoning ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultReasoning: event.target.value || null }))}><option value="">Runtime default</option>{reasoningOptions.map((reasoning: string) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}</select></label><label>Idle process retention<select value={retention} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, retentionMinutes: Number(event.target.value) }))}>{retentionOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} minutes`}{minutes === data.retentionMinutes && ![30, 60, 120, 240, 0].includes(minutes) ? " · saved" : ""}</option>)}</select></label></div><div className="settings-form-row"><button className="button-primary" type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save defaults</button><button type="button" onClick={() => void runtime.refetch()} disabled={runtime.isFetching}>Test connection</button></div>{message && <p role={save.isError || secretSave.isError ? "alert" : "status"} className="settings-message">{message}</p>}<hr /><h4>Provider connection</h4><form className="secret-form" onSubmit={(event) => { event.preventDefault(); if (provider && secret) secretSave.mutate(); }}><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">Choose a runtime provider</option>{providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>API secret<input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Secret is never echoed" /></label><button type="submit" disabled={!provider || !secret || secretSave.isPending}>Save provider secret</button></form></section></div>;
}

function KnowledgeCheckpointSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["knowledge-checkpoint-settings"], queryFn: fetchKnowledgeCheckpointSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<KnowledgeCheckpointSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => updateKnowledgeCheckpointSettings(draft), onSuccess: (data) => { client.setQueryData(["knowledge-checkpoint-settings"], data); setDraft({}); setMessage("Checkpoint settings saved."); }, onError: (error: Error) => setMessage(error.message) });
  const run = useMutation({ mutationFn: runKnowledgeCheckpoint, onSuccess: () => { setMessage("Checkpoint run requested."); void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const push = useMutation({ mutationFn: pushKnowledgeCheckpoint, onSuccess: () => { setMessage("Remote push requested."); void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const data = { ...query.data, ...draft };
  return <section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">Knowledge</p><h3>Checkpoint and remote push</h3><p>Checkpoint and push use separate scheduler tasks and cadence.</p></div></header>{query.isError && <ErrorText error={query.error} />}{save.isError && <ErrorText error={save.error} />}{run.isError && <ErrorText error={run.error} />}{push.isError && <ErrorText error={push.error} />}<div className="settings-grid"><div className="settings-switch-grid"><SettingsSwitch label="Automatic commit" description="Create checkpoint commits on the configured cadence." checked={data.autoCommit ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoCommit: checked }))} /><SettingsSwitch label="Automatic push" description="Push completed checkpoints to the configured remote." checked={data.autoPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoPush: checked }))} /></div><label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label><label>Source ref<input value={data.sourceRef ?? data.branch ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label><label>Remote backup branch<input value={data.remoteBranch ?? "loongboard-knowledge-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label><label>Checkpoint frequency<select value={data.checkpointIntervalMinutes ?? data.intervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label><label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label></div><p className="settings-muted">Last success: {data.lastSuccessAt ?? "—"} · Next checkpoint: {data.nextRunAt ?? "—"}</p>{data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}{message && <p role={save.isError || run.isError || push.isError ? "alert" : "status"} className="settings-message">{message}</p>}<div className="settings-form-row"><button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save backup settings</button><button type="button" onClick={() => run.mutate()} disabled={run.isPending}>Run checkpoint now</button><button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button><Link className="button-link" to="/settings/schedules">Open schedules</Link></div></section>;
}

function CodeBackupSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["code-backup-settings"], queryFn: fetchCodeBackupSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<CodeBackupSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => updateCodeBackupSettings(draft), onSuccess: (data) => { client.setQueryData(["code-backup-settings"], data); setDraft({}); setMessage("Code backup settings saved."); }, onError: (error: Error) => setMessage(error.message) });
  const checkpoint = useMutation({ mutationFn: runCodeBackupCheckpoint, onSuccess: () => { setMessage("Code checkpoint requested."); void client.invalidateQueries({ queryKey: ["code-backup-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const push = useMutation({ mutationFn: pushCodeBackup, onSuccess: () => { setMessage("Code backup push requested."); void client.invalidateQueries({ queryKey: ["code-backup-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const data = { ...query.data, ...draft };
  return <><section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">LoongBoard code</p><h3>Code backup</h3><p>Checkpoint the current app repository without changing its checkout; push uses an explicit source ref to the backup branch.</p></div></header>{query.isError && <ErrorText error={query.error} />}<div className="settings-grid"><label>Repository path<input value={data.repositoryPath ?? ""} readOnly aria-readonly="true" /></label><label>Source ref<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label><label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label><label>Remote backup branch<input value={data.remoteBranch ?? "loongboard-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label><div className="settings-switch-grid"><SettingsSwitch label="Automatic checkpoint" description="Create a source checkpoint on the configured cadence." checked={data.automaticCheckpoint ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticCheckpoint: checked }))} /><SettingsSwitch label="Automatic push" description="Push checkpoints to the configured backup branch." checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} /></div><label>Checkpoint frequency<select value={data.checkpointIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label><label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label></div>{data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}<p className="settings-muted">Last checkpoint: {data.lastCheckpointAt ?? "—"} · Last push: {data.lastPushAt ?? "—"}</p>{message && <p role="status" className="settings-message">{message}</p>}<div className="settings-form-row"><button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save code backup</button><button type="button" onClick={() => checkpoint.mutate()} disabled={checkpoint.isPending}>Checkpoint now</button><button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button></div></section><AgentArchiveSettingsSection /></>;
}

function AgentArchiveSettingsSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["agent-archive-settings"], queryFn: fetchAgentArchiveSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<AgentArchiveSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => updateAgentArchiveSettings(draft), onSuccess: (data) => { client.setQueryData(["agent-archive-settings"], data); setDraft({}); setMessage("Agent archive settings saved."); }, onError: (error: Error) => setMessage(error.message) });
  const exportRun = useMutation({ mutationFn: runAgentArchiveExport, onSuccess: () => { setMessage("Agent archive export requested."); void client.invalidateQueries({ queryKey: ["agent-archive-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const push = useMutation({ mutationFn: pushAgentArchive, onSuccess: () => { setMessage("Agent archive push requested."); void client.invalidateQueries({ queryKey: ["agent-archive-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const data = { ...query.data, ...draft };
  return <section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">Agent history</p><h3>Conversation archive</h3><p>Export uses the normalized allowlist projection; the archive repository never reads DSH homes or secrets.</p></div></header>{query.isError && <ErrorText error={query.error} />}<div className="settings-grid"><label>Archive repository path<input value={data.archiveRepositoryPath ?? ""} onChange={(event) => setDraft((old) => ({ ...old, archiveRepositoryPath: event.target.value }))} /></label><label>Source ref<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label><label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label><label>Remote backup branch<input value={data.remoteBranch ?? "agent-history-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label><div className="settings-switch-grid"><SettingsSwitch label="Automatic export" description="Export normalized transcripts on the configured cadence." checked={data.enabled ?? false} onChange={(checked) => setDraft((old) => ({ ...old, enabled: checked }))} /><SettingsSwitch label="Automatic push" description="Push archive checkpoints to the configured branch." checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} /></div><label>Export/checkpoint frequency<select value={data.exportIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, exportIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label><label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label></div><p className="settings-muted">Last export: {data.lastExportAt ?? "—"} · Next export: {data.nextExportAt ?? "—"} · Last push: {data.lastPushAt ?? "—"}</p>{data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}{message && <p role="status" className="settings-message">{message}</p>}<div className="settings-form-row"><button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save archive settings</button><button type="button" onClick={() => exportRun.mutate()} disabled={exportRun.isPending}>Export checkpoint now</button><button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button></div></section>;
}

export function SettingsControlCenter() {
  return <section className="settings-control-center" aria-labelledby="settings-control-heading"><div className="page-heading"><div><p className="eyebrow">Control center</p><h2 id="settings-control-heading">Workspace settings</h2><p className="page-subtitle">Manage repositories, credentials, runtime defaults, files and scheduled work.</p></div></div><div className="settings-control-grid"><article className="settings-control-tile"><span className="settings-tile-icon">↻</span><h3>Repositories</h3><p>Sync status and automatic frequency for each configured repository.</p><Link to="/settings/repositories">Manage repositories</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">⌁</span><h3>Integrations</h3><p>Verify GitHub access and quota without exposing secrets.</p><Link to="/settings/integrations">Manage integrations</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">✦</span><h3>Agent</h3><p>Runtime health, dynamic defaults and idle retention.</p><Link to="/settings/agent">Configure Agent</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">◇</span><h3>Domains</h3><p>Edit rendered rules, JSON source and update prompts.</p><Link to="/settings/domains">Open Domains</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">◷</span><h3>Schedules</h3><p>Review Agent and system schedules and run history.</p><Link to="/settings/schedules">Open Schedules</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">♥</span><h3>Health</h3><p>Check the API and runtime boundary.</p><Link to="/settings/health">Open Health</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">✓</span><h3>Knowledge checkpoint</h3><p>Configure the existing Knowledge commit and push behavior.</p><Link to="/settings/checkpoint">Manage checkpoint</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">⇧</span><h3>Code backup</h3><p>Protect the LoongBoard source repository with separate checkpoint and push cadence.</p><Link to="/settings/code-backup">Manage code backup</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">⌑</span><h3>Security</h3><p>Enable or change the local password lock for Web/API access.</p><Link to="/settings/security">Manage password lock</Link></article></div></section>;
}

export { RepositoriesSettings, IntegrationsSettings, AgentSettings, KnowledgeCheckpointSettingsPage, CodeBackupSettingsPage, AgentArchiveSettingsSection };
