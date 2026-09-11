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
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";
import { ErrorText } from "./settings-helpers";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function AgentArchiveSection() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["agent-archive-settings"], queryFn: fetchAgentArchiveSettings, refetchInterval: 5_000 });
  const [draft, setDraft] = useState<Partial<AgentArchiveSettings>>({});
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => updateAgentArchiveSettings(draft),
    onSuccess: (data) => {
      client.setQueryData(["agent-archive-settings"], data);
      setDraft({});
      setMessage({ message: { en: "Agent archive settings saved.", "zh-CN": "智能代理归档设置已保存。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving Agent archive settings failed: {detail}", "zh-CN": "保存智能代理归档设置失败：{detail}" }, values: { detail: error.message } }),
  });
  const exportRun = useMutation({
    mutationFn: runAgentArchiveExport,
    onSuccess: () => {
      setMessage({ message: { en: "Agent archive export requested.", "zh-CN": "智能代理归档导出请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["agent-archive-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting an Agent archive export failed: {detail}", "zh-CN": "请求智能代理归档导出失败：{detail}" }, values: { detail: error.message } }),
  });
  const push = useMutation({
    mutationFn: pushAgentArchive,
    onSuccess: () => {
      setMessage({ message: { en: "Agent archive push requested.", "zh-CN": "智能代理归档推送请求已提交。" } });
      void client.invalidateQueries({ queryKey: ["agent-archive-settings"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting an Agent archive push failed: {detail}", "zh-CN": "请求智能代理归档推送失败：{detail}" }, values: { detail: error.message } }),
  });
  const data = { ...query.data, ...draft };

  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">{t({ en: "Agent history", "zh-CN": "智能代理历史" })}</p>
          <h3>{t({ en: "Conversation archive", "zh-CN": "对话归档" })}</h3>
          <p>{t({ en: "Export uses the normalized allowlist projection; the archive repository never reads DSH homes or secrets.", "zh-CN": "导出使用规范化的允许列表投影；归档仓库不会读取 DSH 主目录或密钥。" })}</p>
        </div>
      </header>
      {query.isError && <ErrorText error={query.error} />}
      <div className="settings-grid">
        <label>{t({ en: "Archive repository path", "zh-CN": "归档仓库路径" })}<input value={data.archiveRepositoryPath ?? ""} onChange={(event) => setDraft((old) => ({ ...old, archiveRepositoryPath: event.target.value }))} /></label>
        <label>{t({ en: "Source ref", "zh-CN": "源 ref" })}<input value={data.sourceRef ?? "main"} onChange={(event) => setDraft((old) => ({ ...old, sourceRef: event.target.value }))} /></label>
        <label>{t({ en: "Remote", "zh-CN": "远端" })}<input value={data.remote ?? "origin"} onChange={(event) => setDraft((old) => ({ ...old, remote: event.target.value }))} /></label>
        <label>{t({ en: "Remote backup branch", "zh-CN": "远端备份分支" })}<input value={data.remoteBranch ?? "agent-history-backup"} onChange={(event) => setDraft((old) => ({ ...old, remoteBranch: event.target.value }))} /></label>
        <div className="settings-switch-grid">
          <SettingsSwitch label={t({ en: "Automatic export", "zh-CN": "自动导出" })} description={t({ en: "Export normalized transcripts on the configured cadence.", "zh-CN": "按配置频率导出规范化记录。" })} checked={data.enabled ?? false} onChange={(checked) => setDraft((old) => ({ ...old, enabled: checked }))} />
          <SettingsSwitch label={t({ en: "Automatic push", "zh-CN": "自动推送" })} description={t({ en: "Push archive checkpoints to the configured branch.", "zh-CN": "将归档检查点推送到配置的分支。" })} checked={data.automaticPush ?? false} onChange={(checked) => setDraft((old) => ({ ...old, automaticPush: checked }))} />
        </div>
        <label>{t({ en: "Export/checkpoint frequency", "zh-CN": "导出/检查点频率" })}<select value={data.exportIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, exportIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={30}>{t({ en: "{count} minutes", "zh-CN": "{count} 分钟" }, { count: formatNumber(30) })}</option><option value={60}>{t({ en: "{count} hour", "zh-CN": "{count} 小时" }, { count: formatNumber(1) })}</option><option value={240}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(4) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
        <label>{t({ en: "Push frequency", "zh-CN": "推送频率" })}<select value={data.pushIntervalMinutes ?? ""} onChange={(event) => setDraft((old) => ({ ...old, pushIntervalMinutes: event.target.value ? Number(event.target.value) : null }))}><option value="">{t({ en: "Manual only", "zh-CN": "仅手动" })}</option><option value={360}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(6) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label>
      </div>
      <p className="settings-muted">{t({ en: "Last export:", "zh-CN": "上次导出：" })} {data.lastExportAt ? formatDateTime(data.lastExportAt) : "—"} · {t({ en: "Next export:", "zh-CN": "下次导出：" })} {data.nextExportAt ? formatDateTime(data.nextExportAt) : "—"} · {t({ en: "Last push:", "zh-CN": "上次推送：" })} {data.lastPushAt ? formatDateTime(data.lastPushAt) : "—"}</p>
      {data.lastError && <p role="alert" className="settings-error">{t({ en: "Last error:", "zh-CN": "最近错误：" })} {data.lastError}</p>}
      {message && <p role="status" className="settings-message">{t(message.message, message.values)}</p>}
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save archive settings", "zh-CN": "保存归档设置" })}</button>
        <button type="button" onClick={() => exportRun.mutate()} disabled={exportRun.isPending}>{t({ en: "Export checkpoint now", "zh-CN": "立即导出检查点" })}</button>
        <button type="button" onClick={() => push.mutate()} disabled={push.isPending}>{t({ en: "Push now", "zh-CN": "立即推送" })}</button>
      </div>
    </section>
  );
}

export { AgentArchiveSection as AgentArchiveSettingsSection };
