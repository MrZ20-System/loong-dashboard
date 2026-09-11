import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchAgentArchiveSettings,
  pushAgentArchive,
  runAgentArchiveExport,
  updateAgentArchiveSettings,
  type AgentArchiveSettings,
} from "../../settings-client";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";

export function AgentArchiveSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["agent-archive-settings"], queryFn: fetchAgentArchiveSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<AgentArchiveSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => updateAgentArchiveSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["agent-archive-settings"], data);
      setDraft({});
      setMessage("Agent archive settings saved.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const exportRun = useMutation({
    mutationFn: runAgentArchiveExport,
    onSuccess: () => {
      setMessage("Agent archive export requested.");
      void client.invalidateQueries({ queryKey: ["agent-archive-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const push = useMutation({
    mutationFn: pushAgentArchive,
    onSuccess: () => {
      setMessage("Agent archive push requested.");
      void client.invalidateQueries({ queryKey: ["agent-archive-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const data = { ...query.data, ...draft };

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">Agent history</p>
          <h3>Conversation archive</h3>
          <p>Export uses the normalized allowlist projection; the archive repository never reads DSH homes or secrets.</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      <div className="settings-grid">
        <label>Archive repository path<input value={data.archiveRepositoryPath ?? ""} onChange={(event) => setDraft((old) => ({ ...old, archiveRepositoryPath: event.target.value }))} /></label>
        <label>Source ref<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>Remote backup branch<input value={data.remoteBranch ?? "agent-history-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <div className="settings-switch-grid">
          <SettingsSwitch label="Automatic export" description="Export normalized transcripts on the configured cadence." checked={data.enabled ?? false} onChange={(checked) => setDraft((old) => ({ ...old, enabled: checked }))} />
          <SettingsSwitch label="Automatic push" description="Push archive checkpoints to the configured branch." checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} />
        </div>
        <label>Export/checkpoint frequency<select value={data.exportIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, exportIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label>
        <label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label>
      </div>
      <p className="settings-muted">Last export: {data.lastExportAt ?? "—"} · Next export: {data.nextExportAt ?? "—"} · Last push: {data.lastPushAt ?? "—"}</p>
      {data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}
      {message && <p role="status" className="settings-message">{message}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save archive settings</button>
        <button type="button" onClick={() => exportRun.mutate()} disabled={exportRun.isPending}>Export checkpoint now</button>
        <button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button>
      </div>
    </section>
  );
}

export { AgentArchiveSection as AgentArchiveSettingsSection };
