import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentRuntimeModelCapability } from "@loongboard/contracts";
import { Link } from "react-router-dom";
import { useRepositories } from "../../app/hooks";
import { fetchSyncStatus, startSync } from "../../metadata-client";
import {
  fetchAgentRuntimeSettings,
  fetchGitHubIntegration,
  fetchRepositorySettings,
  removeGitHubToken,
  saveGitHubToken,
  saveProviderSecret,
  updateAgentRuntimeSettings,
  updateRepositorySettings,
  verifyGitHubIntegration,
  type AgentRuntimeSettings,
  type GitHubIntegration,
  fetchKnowledgeCheckpointSettings,
  updateKnowledgeCheckpointSettings,
  runKnowledgeCheckpoint,
  pushKnowledgeCheckpoint,
  type KnowledgeCheckpointSettings,
} from "../../settings-client";

function ErrorText({ error }: { error: unknown }) {
  return <p role="alert" className="settings-error">{error instanceof Error ? error.message : String(error)}</p>;
}

function RepositorySettingsCard({ repositoryId, name, githubOwner, githubName, localPath, pullRequestCount, issueCount }: { repositoryId: string; name: string; githubOwner: string; githubName: string; localPath: string; pullRequestCount?: number; issueCount?: number }) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["repository-settings", repositoryId], queryFn: () => fetchRepositorySettings(repositoryId) });
  const sync = useQuery({ queryKey: ["sync", repositoryId], queryFn: ({ signal }) => fetchSyncStatus(repositoryId, signal), refetchInterval: 5_000 });
  const [frequency, setFrequency] = useState(60);
  const [automatic, setAutomatic] = useState(true);
  const [lookbackDays, setLookbackDays] = useState<7 | 30>(30);
  const save = useMutation({ mutationFn: () => updateRepositorySettings(repositoryId, { automaticSync: automatic, syncFrequencyMinutes: frequency, syncLookbackDays: lookbackDays }), onSuccess: (data) => { client.setQueryData(["repository-settings", repositoryId], data); } });
  const run = useMutation({ mutationFn: () => startSync(repositoryId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["sync", repositoryId] }); } });
  const state = settings.data;
  useEffect(() => {
    if (state === undefined) return;
    setAutomatic(state.automaticSync);
    setFrequency(state.syncFrequencyMinutes);
    setLookbackDays(state.syncLookbackDays ?? 30);
  }, [state?.automaticSync, state?.syncFrequencyMinutes, state?.syncLookbackDays]);
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
    <p className="settings-sync-scope"><strong>First sync includes all PR and issue statuses updated in the last {lookbackDays} days.</strong> Later syncs fetch changes since the last successful sync.<br /><span>Applies when syncing a repository for the first time. Stored locally: {localCounts}</span></p>
    {settings.isError && <ErrorText error={settings.error} />}
    {sync.isError && <ErrorText error={sync.error} />}
    {save.isError && <ErrorText error={save.error} />}
    {run.isError && <ErrorText error={run.error} />}
    {save.isSuccess && <p role="status" className="settings-message">Repository sync settings saved.</p>}
    <div className="settings-form-row"><label className="settings-switch"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} /> Automatic sync</label><label>Every <select value={frequency} onChange={(event) => setFrequency(Number(event.target.value))}><option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label><label>Initial sync range <select value={lookbackDays} onChange={(event) => setLookbackDays(Number(event.target.value) as 7 | 30)}><option value={7}>7 days</option><option value={30}>30 days</option></select></label><button type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save</button><button type="button" className="button-primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Starting…" : "Sync now"}</button></div>
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
  const save = useMutation({ mutationFn: () => updateKnowledgeCheckpointSettings(draft), onSuccess: (data) => { client.setQueryData(["knowledge-checkpoint-settings"], data); setMessage("Checkpoint settings saved."); }, onError: (error: Error) => setMessage(error.message) });
  const run = useMutation({ mutationFn: runKnowledgeCheckpoint, onSuccess: () => { setMessage("Checkpoint run requested."); void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const push = useMutation({ mutationFn: pushKnowledgeCheckpoint, onSuccess: () => { setMessage("Remote push requested."); void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] }); }, onError: (error: Error) => setMessage(error.message) });
  const data = { ...query.data, ...draft };
  return <section className="settings-card"><header className="settings-card__header"><div><p className="eyebrow">Knowledge</p><h3>Checkpoint and remote push</h3><p>Knowledge is the only repository with automatic checkpoint support.</p></div></header>{query.isError && <ErrorText error={query.error} />}{save.isError && <ErrorText error={save.error} />}{run.isError && <ErrorText error={run.error} />}{push.isError && <ErrorText error={push.error} />}<div className="settings-grid"><label><span>Automatic commit</span><input type="checkbox" checked={data.autoCommit ?? false} onChange={(event) => setDraft((old) => ({ ...old, autoCommit: event.target.checked }))} /></label><label><span>Automatic push</span><input type="checkbox" checked={data.autoPush ?? false} onChange={(event) => setDraft((old) => ({ ...old, autoPush: event.target.checked }))} /></label><label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label><label>Branch<input value={data.branch ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, branch: event.target.value }))} /></label><label>Checkpoint frequency<select value={data.intervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, intervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label></div><p className="settings-muted">Last success: {data.lastSuccessAt ?? "—"} · Next run: {data.nextRunAt ?? "—"}</p>{data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}{message && <p role={save.isError || run.isError || push.isError ? "alert" : "status"} className="settings-message">{message}</p>}<div className="settings-form-row"><button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save checkpoint settings</button><button type="button" onClick={() => run.mutate()} disabled={run.isPending}>Run checkpoint now</button><button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button><Link className="button-link" to="/settings/schedules">Open schedules</Link></div></section>;
}

export function SettingsControlCenter() {
  return <section className="settings-control-center" aria-labelledby="settings-control-heading"><div className="page-heading"><div><p className="eyebrow">Control center</p><h2 id="settings-control-heading">Workspace settings</h2><p className="page-subtitle">Manage repositories, credentials, runtime defaults, files and scheduled work.</p></div></div><div className="settings-control-grid"><article className="settings-control-tile"><span className="settings-tile-icon">↻</span><h3>Repositories</h3><p>Sync status and automatic frequency for each configured repository.</p><Link to="/settings/repositories">Manage repositories</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">⌁</span><h3>Integrations</h3><p>Verify GitHub access and quota without exposing secrets.</p><Link to="/settings/integrations">Manage integrations</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">✦</span><h3>Agent</h3><p>Runtime health, dynamic defaults and idle retention.</p><Link to="/settings/agent">Configure Agent</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">◇</span><h3>Domains</h3><p>Edit rendered rules, JSON source and update prompts.</p><Link to="/settings/domains">Open Domains</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">◷</span><h3>Schedules</h3><p>Review Agent and system schedules and run history.</p><Link to="/settings/schedules">Open Schedules</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">♥</span><h3>Health</h3><p>Check the API and runtime boundary.</p><Link to="/settings/health">Open Health</Link></article><article className="settings-control-tile"><span className="settings-tile-icon">✓</span><h3>Knowledge checkpoint</h3><p>Configure the existing Knowledge commit and push behavior.</p><Link to="/settings/checkpoint">Manage checkpoint</Link></article></div></section>;
}

export { RepositoriesSettings, IntegrationsSettings, AgentSettings, KnowledgeCheckpointSettingsPage };
