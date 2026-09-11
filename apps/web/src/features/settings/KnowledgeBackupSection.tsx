import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchKnowledgeCheckpointSettings,
  pushKnowledgeCheckpoint,
  runKnowledgeCheckpoint,
  updateKnowledgeCheckpointSettings,
  type KnowledgeCheckpointSettings,
} from "../../settings-client";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";

export function KnowledgeBackupSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["knowledge-checkpoint-settings"], queryFn: fetchKnowledgeCheckpointSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<KnowledgeCheckpointSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => updateKnowledgeCheckpointSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["knowledge-checkpoint-settings"], data);
      setDraft({});
      setMessage("Checkpoint settings saved.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const run = useMutation({
    mutationFn: runKnowledgeCheckpoint,
    onSuccess: () => {
      setMessage("Checkpoint run requested.");
      void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const push = useMutation({
    mutationFn: pushKnowledgeCheckpoint,
    onSuccess: () => {
      setMessage("Remote push requested.");
      void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const data = { ...query.data, ...draft };

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">Knowledge</p>
          <h3>Checkpoint and remote push</h3>
          <p>Checkpoint and push use separate scheduler tasks and cadence.</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      {save.isError && <ErrorText error={save.error} />}
      {run.isError && <ErrorText error={run.error} />}
      {push.isError && <ErrorText error={push.error} />}
      <div className="settings-grid">
        <div className="settings-switch-grid">
          <SettingsSwitch label="Automatic commit" description="Create checkpoint commits on the configured cadence." checked={data.autoCommit ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoCommit: checked }))} />
          <SettingsSwitch label="Automatic push" description="Push completed checkpoints to the configured remote." checked={data.autoPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoPush: checked }))} />
        </div>
        <label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>Source ref<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>Remote backup branch<input value={data.remoteBranch ?? "loongboard-knowledge-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <label>Checkpoint frequency<select value={data.checkpointIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label>
        <label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label>
      </div>
      <p className="settings-muted">Last success: {data.lastSuccessAt ?? "—"} · Next checkpoint: {data.nextRunAt ?? "—"}</p>
      {data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}
      {message && <p role={save.isError || run.isError || push.isError ? "alert" : "status"} className="settings-message">{message}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save backup settings</button>
        <button type="button" onClick={() => run.mutate()} disabled={run.isPending}>Run checkpoint now</button>
        <button type="button" onClick={() => push.mutate()} disabled={push.isPending}>Push now</button>
        <Link className="button-link" to="/settings/schedules">Open schedules</Link>
      </div>
    </section>
  );
}

export { KnowledgeBackupSection as KnowledgeCheckpointSettingsPage };
