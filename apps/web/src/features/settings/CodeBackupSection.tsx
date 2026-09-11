import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchCodeBackupSettings,
  pushCodeBackup,
  runCodeBackupCheckpoint,
  updateCodeBackupSettings,
  type CodeBackupSettings,
} from "../../settings-client";
import { AgentArchiveSection } from "./AgentArchiveSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";

export function CodeBackupSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["code-backup-settings"], queryFn: fetchCodeBackupSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<CodeBackupSettings>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => updateCodeBackupSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["code-backup-settings"], data);
      setDraft({});
      setMessage("Code backup settings saved.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const checkpoint = useMutation({
    mutationFn: runCodeBackupCheckpoint,
    onSuccess: () => {
      setMessage("Code checkpoint requested.");
      void client.invalidateQueries({ queryKey: ["code-backup-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const push = useMutation({
    mutationFn: pushCodeBackup,
    onSuccess: () => {
      setMessage("Code backup push requested.");
      void client.invalidateQueries({ queryKey: ["code-backup-settings"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const data = { ...query.data, ...draft };
  const runtimeAvailability = query.data !== undefined && "available" in query.data ? query.data.available : undefined;
  const available = runtimeAvailability === true;

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">LoongBoard code</p>
          <h3>Code backup</h3>
          <p>Checkpoint the current app repository without changing its checkout; push uses an explicit source ref to the backup branch.</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      {runtimeAvailability === false && <p role="status" className="settings-muted">Code backup unavailable in container-image deployment.</p>}
      <div className="settings-grid">
        <label>Repository path<input value={data.repositoryPath ?? ""} readOnly aria-readonly="true" /></label>
        <label>Source ref<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>Remote<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>Remote backup branch<input value={data.remoteBranch ?? "loongboard-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <div className="settings-switch-grid">
          <SettingsSwitch label="Automatic checkpoint" description="Create a source checkpoint on the configured cadence." checked={data.automaticCheckpoint ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticCheckpoint: checked }))} disabled={!available || query.isPending} />
          <SettingsSwitch label="Automatic push" description="Push checkpoints to the configured backup branch." checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} disabled={!available || query.isPending} />
        </div>
        <label>Checkpoint frequency<select value={data.checkpointIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>Daily</option></select></label>
        <label>Push frequency<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">Manual only</option><option value={360}>6 hours</option><option value={1440}>Daily</option></select></label>
      </div>
      {data.lastError && <p role="alert" className="settings-error">{data.lastError}</p>}
      <p className="settings-muted">Last checkpoint: {data.lastCheckpointAt ?? "—"} · Last push: {data.lastPushAt ?? "—"}</p>
      {message && <p role="status" className="settings-message">{message}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save code backup</button>
        <button type="button" onClick={() => checkpoint.mutate()} disabled={!available || query.isPending || checkpoint.isPending}>Checkpoint now</button>
        <button type="button" onClick={() => push.mutate()} disabled={!available || query.isPending || push.isPending}>Push now</button>
      </div>
    </section>
  );
}

export function CodeBackupSettingsPage() {
  return <><CodeBackupSection /><AgentArchiveSection /></>;
}
