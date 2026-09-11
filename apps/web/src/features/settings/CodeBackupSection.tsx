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
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";
import { ErrorText } from "./settings-helpers";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function CodeBackupSection() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["code-backup-settings"], queryFn: fetchCodeBackupSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<CodeBackupSettings>>({});
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => updateCodeBackupSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["code-backup-settings"], data);
      setDraft({});
      setMessage({ message: { en: "Code backup settings saved.", "zh-CN": "代码备份设置已保存。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving code backup settings failed: {detail}", "zh-CN": "保存代码备份设置失败：{detail}" }, values: { detail: error.message } }),
  });
  const checkpoint = useMutation({
    mutationFn: runCodeBackupCheckpoint,
    onSuccess: () => {
      setMessage({ message: { en: "Code checkpoint requested.", "zh-CN": "代码检查点请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["code-backup-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a code checkpoint failed: {detail}", "zh-CN": "请求代码检查点失败：{detail}" }, values: { detail: error.message } }),
  });
  const push = useMutation({
    mutationFn: pushCodeBackup,
    onSuccess: () => {
      setMessage({ message: { en: "Code backup push requested.", "zh-CN": "代码备份推送请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["code-backup-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a code backup push failed: {detail}", "zh-CN": "请求代码备份推送失败：{detail}" }, values: { detail: error.message } }),
  });
  const data = { ...query.data, ...draft };
  const runtimeAvailability = query.data !== undefined && "available" in query.data ? query.data.available : undefined;
  const available = runtimeAvailability === true;

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">{t({ en: "LoongBoard code", "zh-CN": "LoongBoard 代码" })}</p>
          <h3>{t({ en: "Code backup", "zh-CN": "代码备份" })}</h3>
          <p>{t({ en: "Checkpoint the current app repository without changing its checkout; push uses an explicit source ref to the backup branch.", "zh-CN": "为当前应用仓库创建检查点而不改变其检出状态；推送使用明确的源 ref 到备份分支。" })}</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      {runtimeAvailability === false && <p role="status" className="settings-muted">{t({ en: "Code backup unavailable in container-image deployment.", "zh-CN": "容器镜像部署中不可用代码备份。" })}</p>}
      <div className="settings-grid">
        <label>{t({ en: "Repository path", "zh-CN": "仓库路径" })}<input value={data.repositoryPath ?? ""} readOnly aria-readonly="true" /></label>
        <label>{t({ en: "Source ref", "zh-CN": "源 ref" })}<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>{t({ en: "Remote", "zh-CN": "远端" })}<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>{t({ en: "Remote backup branch", "zh-CN": "远端备份分支" })}<input value={data.remoteBranch ?? "loongboard-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <div className="settings-switch-grid">
          <SettingsSwitch label={t({ en: "Automatic checkpoint", "zh-CN": "自动创建检查点" })} description={t({ en: "Create a source checkpoint on the configured cadence.", "zh-CN": "按配置频率创建源代码检查点。" })} checked={data.automaticCheckpoint ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticCheckpoint: checked }))} disabled={!available || query.isPending} />
          <SettingsSwitch label={t({ en: "Automatic push", "zh-CN": "自动推送" })} description={t({ en: "Push checkpoints to the configured backup branch.", "zh-CN": "将检查点推送到配置的备份分支。" })} checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} disabled={!available || query.isPending} />
        </div>
        <label>{t({ en: "Checkpoint frequency", "zh-CN": "检查点频率" })}<select value={data.checkpointIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={30}>{t({ en: "{count} minutes", "zh-CN": "{count} 分钟" }, { count: formatNumber(30) })}</option><option value={60}>{t({ en: "{count} hour", "zh-CN": "{count} 小时" }, { count: formatNumber(1) })}</option><option value={240}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(4) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
        <label>{t({ en: "Push frequency", "zh-CN": "推送频率" })}<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={360}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(6) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
      </div>
      {data.lastError && <p role="alert" className="settings-error">{t({ en: "Last error:", "zh-CN": "最近错误：" })} {data.lastError}</p>}
      <p className="settings-muted">{t({ en: "Last checkpoint:", "zh-CN": "上次检查点：" })} {data.lastCheckpointAt ? formatDateTime(data.lastCheckpointAt) : "—"} · {t({ en: "Last push:", "zh-CN": "上次推送：" })} {data.lastPushAt ? formatDateTime(data.lastPushAt) : "—"}</p>
      {message && <p role="status" className="settings-message">{t(message.message, message.values)}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save code backup", "zh-CN": "保存代码备份" })}</button>
        <button type="button" onClick={() => checkpoint.mutate()} disabled={!available || query.isPending || checkpoint.isPending}>{t({ en: "Checkpoint now", "zh-CN": "立即创建检查点" })}</button>
        <button type="button" onClick={() => push.mutate()} disabled={!available || query.isPending || push.isPending}>{t({ en: "Push now", "zh-CN": "立即推送" })}</button>
      </div>
    </section>
  );
}

export function CodeBackupSettingsPage() {
  return <><CodeBackupSection /><AgentArchiveSection /></>;
}
