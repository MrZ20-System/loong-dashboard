import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RepositoryRetentionSettings } from "@loongboard/contracts";
import { todayValue } from "../../components/filters/date-utils";
import {
  fetchRepositorySettings,
  updateRepositorySettings,
} from "../../settings-client";
import {
  fetchMaintenanceRuns,
  previewRepositoryMaintenance,
  startRepositoryMaintenance,
} from "../../retention-client";
import { SettingsSwitch } from "./SettingsSwitch";

const DEFAULT_RETENTION: RepositoryRetentionSettings = {
  automaticArchiveEnabled: false,
  archiveAfterDays: 7,
  includeMergedPrs: true,
  includeClosedPrs: true,
  includeClosedIssues: true,
  prunePayloadWhenArchived: true,
};

function retentionOrDefault(value: RepositoryRetentionSettings | undefined): RepositoryRetentionSettings {
  return { ...DEFAULT_RETENTION, ...(value ?? {}) };
}

export function RepositoryRetentionSection({ repositoryId }: { repositoryId: string }) {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["repository-settings", repositoryId],
    queryFn: () => fetchRepositorySettings(repositoryId),
  });
  const runs = useQuery({
    queryKey: ["maintenance-runs", repositoryId],
    queryFn: () => fetchMaintenanceRuns(repositoryId),
    refetchInterval: 5_000,
  });
  const [retention, setRetention] = useState(DEFAULT_RETENTION);
  const [date, setDate] = useState(() => todayValue());
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewRepositoryMaintenance>> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const state = settings.data;

  useEffect(() => {
    if (state?.retention === undefined) return;
    setRetention(retentionOrDefault(state.retention));
  }, [state?.retention]);

  const save = useMutation({
    mutationFn: () => updateRepositorySettings(repositoryId, { retention }),
    onSuccess: (data) => {
      client.setQueryData(["repository-settings", repositoryId], data);
      setMessage("Data retention settings saved.");
    },
  });
  const previewRun = useMutation({
    mutationFn: () => previewRepositoryMaintenance(repositoryId, {
      date,
      includeMergedPrs: retention.includeMergedPrs,
      includeClosedPrs: retention.includeClosedPrs,
      includeClosedIssues: retention.includeClosedIssues,
    }),
    onSuccess: (data) => setPreview(data),
  });
  const run = useMutation({
    mutationFn: () => startRepositoryMaintenance(repositoryId, {
      date,
      includeMergedPrs: retention.includeMergedPrs,
      includeClosedPrs: retention.includeClosedPrs,
      includeClosedIssues: retention.includeClosedIssues,
      prune: retention.prunePayloadWhenArchived,
    }),
    onSuccess: (accepted) => {
      setMessage(`Archive queued (${accepted.runId}).`);
      void client.invalidateQueries({ queryKey: ["maintenance-runs", repositoryId] });
    },
  });
  const actionError = settings.error ?? runs.error ?? save.error ?? previewRun.error ?? run.error;
  const latestRun = runs.data?.items[0];

  const update = <K extends keyof RepositoryRetentionSettings>(key: K, value: RepositoryRetentionSettings[K]) => {
    setRetention((current) => ({ ...current, [key]: value }));
    setPreview(null);
  };
  const start = () => {
    if (!window.confirm("Archive the selected terminal metadata? Pruned cached payloads will need a GitHub refresh.")) return;
    run.mutate();
  };

  return (
    <section className="settings-subsection retention-section" aria-labelledby={`retention-${repositoryId}`}>
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">Data retention</p>
          <h4 id={`retention-${repositoryId}`}>Archive terminal metadata</h4>
          <p className="settings-muted">Archived items stay available in the Archived and All views. Only cached payloads are cleaned when pruning is enabled.</p>
        </div>
        <span className={`status-pill status-pill--${retention.automaticArchiveEnabled ? "ok" : "unknown"}`}>
          {retention.automaticArchiveEnabled ? "Automatic" : "Manual only"}
        </span>
      </header>
      <div className="settings-grid">
        <div className="settings-switch-grid">
          <SettingsSwitch label="Automatic archive" description="Run the existing daily scheduler for terminal metadata." checked={retention.automaticArchiveEnabled} onChange={(checked) => update("automaticArchiveEnabled", checked)} />
          <SettingsSwitch label="Prune payload when archived" description="Remove cached files/comments and keep a pruned marker." checked={retention.prunePayloadWhenArchived} onChange={(checked) => update("prunePayloadWhenArchived", checked)} />
        </div>
        <label>Archive after<select value={retention.archiveAfterDays} onChange={(event) => update("archiveAfterDays", Number(event.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>365 days</option></select></label>
      </div>
      <fieldset className="settings-retention-scopes">
        <legend>Archive scopes</legend>
        <label><input type="checkbox" checked={retention.includeMergedPrs} onChange={(event) => update("includeMergedPrs", event.target.checked)} /> Merged PRs</label>
        <label><input type="checkbox" checked={retention.includeClosedPrs} onChange={(event) => update("includeClosedPrs", event.target.checked)} /> Closed PRs</label>
        <label><input type="checkbox" checked={retention.includeClosedIssues} onChange={(event) => update("includeClosedIssues", event.target.checked)} /> Closed issues</label>
      </fieldset>
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save retention"}</button>
      </div>
      <section className="settings-maintenance-manual" aria-labelledby={`manual-maintenance-${repositoryId}`}>
        <h5 id={`manual-maintenance-${repositoryId}`}>Manual maintenance</h5>
        <p className="settings-muted">Archive terminal items last updated before the start of this date in the server timezone.</p>
        <div className="settings-form-row">
          <label>Before local date<input aria-label="Maintenance cutoff date" type="date" value={date} onChange={(event) => { setDate(event.target.value); setPreview(null); }} /></label>
          <button type="button" onClick={() => previewRun.mutate()} disabled={!date || previewRun.isPending}>{previewRun.isPending ? "Previewing…" : "Preview"}</button>
          <button type="button" className="button-primary" onClick={start} disabled={run.isPending || preview === null}>{run.isPending ? "Queueing…" : "Archive & clean"}</button>
        </div>
        {preview && <dl className="settings-details retention-preview-counts"><div><dt>Merged PRs</dt><dd>{preview.mergedPrCount}</dd></div><div><dt>Closed PRs</dt><dd>{preview.closedPrCount}</dd></div><div><dt>Closed issues</dt><dd>{preview.closedIssueCount}</dd></div><div><dt>Files</dt><dd>{preview.prFileRows}</dd></div><div><dt>Comments</dt><dd>{preview.issueCommentRows}</dd></div><div><dt>Payloads</dt><dd>{preview.prPayloadCount + preview.issuePayloadCount}</dd></div></dl>}
      </section>
      <section className="settings-maintenance-runs" aria-labelledby={`maintenance-runs-${repositoryId}`}>
        <h5 id={`maintenance-runs-${repositoryId}`}>Recent maintenance</h5>
        {latestRun ? <p className="settings-muted"><span className={`status-pill status-pill--${latestRun.status}`}>{latestRun.status}</span> · {latestRun.prCount} PR · {latestRun.issueCount} issues · {latestRun.filesDeleted} files · {latestRun.commentsDeleted} comments{latestRun.error ? ` · ${latestRun.error}` : ""}</p> : <p className="settings-muted">No maintenance runs yet.</p>}
        <p className="settings-muted">Sync run history remains available separately; no runtime-history cleanup is performed here.</p>
      </section>
      {actionError && <p role="alert" className="settings-error">{actionError instanceof Error ? actionError.message : String(actionError)}</p>}
      {message && <p role="status" className="settings-message">{message}</p>}
    </section>
  );
}
