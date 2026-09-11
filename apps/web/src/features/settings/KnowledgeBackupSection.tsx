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
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";
import { ErrorText } from "./settings-helpers";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function KnowledgeBackupSection() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["knowledge-checkpoint-settings"], queryFn: fetchKnowledgeCheckpointSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<KnowledgeCheckpointSettings>>({});
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => updateKnowledgeCheckpointSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["knowledge-checkpoint-settings"], data);
      setDraft({});
      setMessage({ message: { en: "Checkpoint settings saved.", "zh-CN": "检查点设置已保存。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving checkpoint settings failed: {detail}", "zh-CN": "保存检查点设置失败：{detail}" }, values: { detail: error.message } }),
  });
  const run = useMutation({
    mutationFn: runKnowledgeCheckpoint,
    onSuccess: () => {
      setMessage({ message: { en: "Checkpoint run requested.", "zh-CN": "检查点运行请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a checkpoint run failed: {detail}", "zh-CN": "请求运行检查点失败：{detail}" }, values: { detail: error.message } }),
  });
  const push = useMutation({
    mutationFn: pushKnowledgeCheckpoint,
    onSuccess: () => {
      setMessage({ message: { en: "Remote push requested.", "zh-CN": "远端推送请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["knowledge-checkpoint-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a remote push failed: {detail}", "zh-CN": "请求远端推送失败：{detail}" }, values: { detail: error.message } }),
  });
  const data = { ...query.data, ...draft };

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">{t({ en: "Knowledge", "zh-CN": "知识库" })}</p>
          <h3>{t({ en: "Checkpoint and remote push", "zh-CN": "检查点和远端推送" })}</h3>
          <p>{t({ en: "Checkpoint and push use separate scheduler tasks and cadence.", "zh-CN": "检查点和推送使用独立的调度任务和频率。" })}</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      {save.isError && <ErrorText error={save.error} />}
      {run.isError && <ErrorText error={run.error} />}
      {push.isError && <ErrorText error={push.error} />}
      <div className="settings-grid">
        <div className="settings-switch-grid">
          <SettingsSwitch label={t({ en: "Automatic commit", "zh-CN": "自动提交" })} description={t({ en: "Create checkpoint commits on the configured cadence.", "zh-CN": "按配置频率创建检查点提交。" })} checked={data.autoCommit ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoCommit: checked }))} />
          <SettingsSwitch label={t({ en: "Automatic push", "zh-CN": "自动推送" })} description={t({ en: "Push completed checkpoints to the configured remote.", "zh-CN": "将完成的检查点推送到配置的远端。" })} checked={data.autoPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, autoPush: checked }))} />
        </div>
        <label>{t({ en: "Remote", "zh-CN": "远端" })}<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>{t({ en: "Source ref", "zh-CN": "源 ref" })}<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>{t({ en: "Remote backup branch", "zh-CN": "远端备份分支" })}<input value={data.remoteBranch ?? "loongboard-knowledge-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <label>{t({ en: "Checkpoint frequency", "zh-CN": "检查点频率" })}<select value={data.checkpointIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, checkpointIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={30}>{t({ en: "{count} minutes", "zh-CN": "{count} 分钟" }, { count: formatNumber(30) })}</option><option value={60}>{t({ en: "{count} hour", "zh-CN": "{count} 小时" }, { count: formatNumber(1) })}</option><option value={240}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(4) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
        <label>{t({ en: "Push frequency", "zh-CN": "推送频率" })}<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={360}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(6) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
      </div>
      <p className="settings-muted">{t({ en: "Last success:", "zh-CN": "上次成功：" })} {data.lastSuccessAt ? formatDateTime(data.lastSuccessAt) : "—"} · {t({ en: "Next checkpoint:", "zh-CN": "下次检查点：" })} {data.nextRunAt ? formatDateTime(data.nextRunAt) : "—"}</p>
      {data.lastError && <p role="alert" className="settings-error">{t({ en: "Last error:", "zh-CN": "最近错误：" })} {data.lastError}</p>}
      {message && <p role={save.isError || run.isError || push.isError ? "alert" : "status"} className="settings-message">{t(message.message, message.values)}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save backup settings", "zh-CN": "保存备份设置" })}</button>
        <button type="button" onClick={() => run.mutate()} disabled={run.isPending}>{t({ en: "Run checkpoint now", "zh-CN": "立即运行检查点" })}</button>
        <button type="button" onClick={() => push.mutate()} disabled={push.isPending}>{t({ en: "Push now", "zh-CN": "立即推送" })}</button>
        <Link className="button-link" to="/settings/schedules">{t({ en: "Open schedules", "zh-CN": "打开计划任务" })}</Link>
      </div>
    </section>
  );
}

export { KnowledgeBackupSection as KnowledgeCheckpointSettingsPage };
