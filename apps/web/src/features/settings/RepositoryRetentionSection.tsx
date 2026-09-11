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
  previewRuntimeHistoryPurge,
  startRepositoryMaintenance,
  startRuntimeHistoryPurge,
} from "../../retention-client";
import { SettingsSwitch } from "./SettingsSwitch";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

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
  const { t, formatNumber } = useI18n();
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
  const [runtimeHistoryPreview, setRuntimeHistoryPreview] = useState<Awaited<ReturnType<typeof previewRuntimeHistoryPurge>> | null>(null);
  const [message, setMessage] = useState<Feedback | null>(null);
  const state = settings.data;

  useEffect(() => {
    if (state?.retention === undefined) return;
    setRetention(retentionOrDefault(state.retention));
  }, [state?.retention]);

  const save = useMutation({
    mutationFn: () => updateRepositorySettings(repositoryId, { retention }),
    onSuccess: (data) => {
      client.setQueryData(["repository-settings", repositoryId], data);
      setMessage({ message: { en: "Data retention settings saved.", "zh-CN": "数据保留设置已保存。" } });
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
      setMessage({ message: { en: "Archive queued ({runId}).", "zh-CN": "归档已排队（{runId}）。" }, values: { runId: accepted.runId } });
      void client.invalidateQueries({ queryKey: ["maintenance-runs", repositoryId] });
    },
  });
  const runtimePreviewRun = useMutation({
    mutationFn: () => previewRuntimeHistoryPurge(repositoryId),
    onSuccess: (data) => setRuntimeHistoryPreview(data),
  });
  const runtimeRun = useMutation({
    mutationFn: () => startRuntimeHistoryPurge(repositoryId),
    onSuccess: (accepted) => {
      setMessage({ message: { en: "Run history cleanup queued ({runId}).", "zh-CN": "运行历史清理已排队（{runId}）。" }, values: { runId: accepted.runId } });
      void client.invalidateQueries({ queryKey: ["maintenance-runs", repositoryId] });
    },
  });
  const actionError = settings.error ?? runs.error ?? save.error ?? previewRun.error ?? run.error ?? runtimePreviewRun.error ?? runtimeRun.error;
  const latestRun = runs.data?.items[0];
  const latestRuntimeRun = runs.data?.items.find((item) => item.kind === "purge_runtime_history");
  const runsDeleted = latestRuntimeRun?.selector.runsDeleted;

  const update = <K extends keyof RepositoryRetentionSettings>(key: K, value: RepositoryRetentionSettings[K]) => {
    setRetention((current) => ({ ...current, [key]: value }));
    setPreview(null);
  };
  const start = () => {
    if (!window.confirm(t({ en: "Archive the selected terminal metadata? Pruned cached payloads will need a GitHub refresh.", "zh-CN": "要归档选定的终结元数据吗？清理后的缓存载荷需要从 GitHub 刷新。" }))) return;
    run.mutate();
  };
  const cleanRuntimeHistory = () => {
    if (!window.confirm(t({ en: "Clean sync-run history older than {days} days, retaining the latest {runs} runs?", "zh-CN": "要清理超过 {days} 天的同步运行历史，并保留最新 {runs} 次运行吗？" }, { days: formatNumber(30), runs: formatNumber(100) }))) return;
    runtimeRun.mutate();
  };

  return (
    <section className="settings-subsection retention-section" aria-labelledby={`retention-${repositoryId}`}>
      <header className="settings-card__header">
        <div>
          <p className="eyebrow">{t({ en: "Data retention", "zh-CN": "数据保留" })}</p>
          <h4 id={`retention-${repositoryId}`}>{t({ en: "Archive terminal metadata", "zh-CN": "归档终结元数据" })}</h4>
          <p className="settings-muted">{t({ en: "Archived items stay available in the Archived and All views. Only cached payloads are cleaned when pruning is enabled.", "zh-CN": "归档项目仍可在“已归档”和“全部”视图中查看。启用清理时只会清理缓存载荷。" })}</p>
        </div>
        <span className={`status-pill status-pill--${retention.automaticArchiveEnabled ? "ok" : "unknown"}`}>
          {retention.automaticArchiveEnabled ? t({ en: "Automatic", "zh-CN": "自动" }) : t({ en: "Manual only", "zh-CN": "仅手动" })}
        </span>
      </header>
      <div className="settings-grid">
        <div className="settings-switch-grid">
          <SettingsSwitch label={t({ en: "Automatic archive", "zh-CN": "自动归档" })} description={t({ en: "Run the existing daily scheduler for terminal metadata.", "zh-CN": "运行现有的每日终结元数据调度任务。" })} checked={retention.automaticArchiveEnabled} onChange={(checked) => update("automaticArchiveEnabled", checked)} />
          <SettingsSwitch label={t({ en: "Prune payload when archived", "zh-CN": "归档时清理载荷" })} description={t({ en: "Remove cached files/comments and keep a pruned marker.", "zh-CN": "移除缓存文件/评论并保留已清理标记。" })} checked={retention.prunePayloadWhenArchived} onChange={(checked) => update("prunePayloadWhenArchived", checked)} />
        </div>
        <label>{t({ en: "Archive after", "zh-CN": "归档延迟" })}<select value={retention.archiveAfterDays} onChange={(event) => update("archiveAfterDays", Number(event.target.value))}><option value={7}>{t({ en: "{count} days", "zh-CN": "{count} 天" }, { count: formatNumber(7) })}</option><option value={14}>{t({ en: "{count} days", "zh-CN": "{count} 天" }, { count: formatNumber(14) })}</option><option value={30}>{t({ en: "{count} days", "zh-CN": "{count} 天" }, { count: formatNumber(30) })}</option><option value={90}>{t({ en: "{count} days", "zh-CN": "{count} 天" }, { count: formatNumber(90) })}</option><option value={365}>{t({ en: "{count} days", "zh-CN": "{count} 天" }, { count: formatNumber(365) })}</option></select></label>
      </div>
      <fieldset className="settings-retention-scopes">
        <legend>{t({ en: "Archive scopes", "zh-CN": "归档范围" })}</legend>
        <label><input type="checkbox" checked={retention.includeMergedPrs} onChange={(event) => update("includeMergedPrs", event.target.checked)} /> {t({ en: "Merged PRs", "zh-CN": "已合并 PR" })}</label>
        <label><input type="checkbox" checked={retention.includeClosedPrs} onChange={(event) => update("includeClosedPrs", event.target.checked)} /> {t({ en: "Closed PRs", "zh-CN": "已关闭 PR" })}</label>
        <label><input type="checkbox" checked={retention.includeClosedIssues} onChange={(event) => update("includeClosedIssues", event.target.checked)} /> {t({ en: "Closed issues", "zh-CN": "已关闭 Issue" })}</label>
      </fieldset>
      <div className="settings-form-row">
        <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t({ en: "Saving…", "zh-CN": "保存中…" }) : t({ en: "Save retention", "zh-CN": "保存保留设置" })}</button>
      </div>
      <section className="settings-maintenance-manual" aria-labelledby={`manual-maintenance-${repositoryId}`}>
        <h5 id={`manual-maintenance-${repositoryId}`}>{t({ en: "Manual maintenance", "zh-CN": "手动维护" })}</h5>
        <p className="settings-muted">{t({ en: "Archive terminal items last updated before the start of this date in the server timezone.", "zh-CN": "归档服务器时区中在此日期开始前最后更新的终结项目。" })}</p>
        <div className="settings-form-row">
          <label>{t({ en: "Before local date", "zh-CN": "本地日期之前" })}<input aria-label={t({ en: "Maintenance cutoff date", "zh-CN": "维护截止日期" })} type="date" value={date} onChange={(event) => { setDate(event.target.value); setPreview(null); }} /></label>
          <button type="button" onClick={() => previewRun.mutate()} disabled={!date || previewRun.isPending}>{previewRun.isPending ? t({ en: "Previewing…", "zh-CN": "预览中…" }) : t({ en: "Preview", "zh-CN": "预览" })}</button>
          <button type="button" className="button-primary" onClick={start} disabled={run.isPending || preview === null}>{run.isPending ? t({ en: "Queueing…", "zh-CN": "排队中…" }) : t({ en: "Archive & clean", "zh-CN": "归档并清理" })}</button>
        </div>
        {preview && <dl className="settings-details retention-preview-counts"><div><dt>{t({ en: "Merged PRs", "zh-CN": "已合并 PR" })}</dt><dd>{formatNumber(preview.mergedPrCount)}</dd></div><div><dt>{t({ en: "Closed PRs", "zh-CN": "已关闭 PR" })}</dt><dd>{formatNumber(preview.closedPrCount)}</dd></div><div><dt>{t({ en: "Closed issues", "zh-CN": "已关闭 Issue" })}</dt><dd>{formatNumber(preview.closedIssueCount)}</dd></div><div><dt>{t({ en: "Files", "zh-CN": "文件" })}</dt><dd>{formatNumber(preview.prFileRows)}</dd></div><div><dt>{t({ en: "Comments", "zh-CN": "评论" })}</dt><dd>{formatNumber(preview.issueCommentRows)}</dd></div><div><dt>{t({ en: "Payloads", "zh-CN": "载荷" })}</dt><dd>{formatNumber(preview.prPayloadCount + preview.issuePayloadCount)}</dd></div></dl>}
      </section>
      <section className="settings-maintenance-storage" aria-labelledby={`storage-maintenance-${repositoryId}`}>
        <h5 id={`storage-maintenance-${repositoryId}`}>{t({ en: "Storage maintenance", "zh-CN": "存储维护" })}</h5>
        <p className="settings-muted">{t({ en: "Sync-run history cleanup is fixed at {days} days while retaining at least the latest {runs} runs. Active and history-protected runs are never deleted.", "zh-CN": "同步运行历史清理固定为 {days} 天，同时至少保留最近 {runs} 次运行。活动运行和受历史保护的运行不会被删除。" }, { days: formatNumber(30), runs: formatNumber(100) })}</p>
        <div className="settings-form-row">
          <button type="button" onClick={() => runtimePreviewRun.mutate()} disabled={runtimePreviewRun.isPending}>{runtimePreviewRun.isPending ? t({ en: "Previewing…", "zh-CN": "预览中…" }) : t({ en: "Preview run history", "zh-CN": "预览运行历史" })}</button>
          <button type="button" className="button-primary" onClick={cleanRuntimeHistory} disabled={runtimeRun.isPending || runtimeHistoryPreview === null}>{runtimeRun.isPending ? t({ en: "Queueing…", "zh-CN": "排队中…" }) : t({ en: "Clean run history", "zh-CN": "清理运行历史" })}</button>
        </div>
        {runtimeHistoryPreview && <dl className="settings-details retention-preview-counts"><div><dt>{t({ en: "Runs to delete", "zh-CN": "待删除运行" })}</dt><dd>{formatNumber(runtimeHistoryPreview.runCount)}</dd></div><div><dt>{t({ en: "Protected runs", "zh-CN": "受保护运行" })}</dt><dd>{formatNumber(runtimeHistoryPreview.protectedRunCount)}</dd></div><div><dt>{t({ en: "Active runs", "zh-CN": "活动运行" })}</dt><dd>{formatNumber(runtimeHistoryPreview.queuedOrRunningCount)}</dd></div><div><dt>{t({ en: "Streams", "zh-CN": "流" })}</dt><dd>{formatNumber(runtimeHistoryPreview.streamCount)}</dd></div><div><dt>{t({ en: "Targets", "zh-CN": "目标" })}</dt><dd>{formatNumber(runtimeHistoryPreview.targetCount)}</dd></div></dl>}
        {latestRuntimeRun && <p className="settings-muted"><span className={`status-pill status-pill--${latestRuntimeRun.status}`}>{latestRuntimeRun.status}</span> · {typeof runsDeleted === "number" ? t({ en: "{count} runs deleted", "zh-CN": "已删除 {count} 次运行" }, { count: formatNumber(runsDeleted) }) : t({ en: "No runs deleted", "zh-CN": "没有删除运行" })}</p>}
      </section>
      <section className="settings-maintenance-runs" aria-labelledby={`maintenance-runs-${repositoryId}`}>
        <h5 id={`maintenance-runs-${repositoryId}`}>{t({ en: "Recent maintenance", "zh-CN": "最近维护" })}</h5>
        {latestRun ? <p className="settings-muted"><span className={`status-pill status-pill--${latestRun.status}`}>{latestRun.status}</span> · {t({ en: "{prCount} PR · {issueCount} issues · {files} files · {comments} comments", "zh-CN": "{prCount} PR · {issueCount} 个 Issue · {files} 个文件 · {comments} 条评论" }, { prCount: formatNumber(latestRun.prCount), issueCount: formatNumber(latestRun.issueCount), files: formatNumber(latestRun.filesDeleted), comments: formatNumber(latestRun.commentsDeleted) })}{latestRun.error ? ` · ${t({ en: "Error:", "zh-CN": "错误：" })} ${latestRun.error}` : ""}</p> : <p className="settings-muted">{t({ en: "No maintenance runs yet.", "zh-CN": "还没有维护运行。" })}</p>}
        <p className="settings-muted">{t({ en: "Run-history cleanup uses the fixed {days}-day and latest-{runs} safety policy above.", "zh-CN": "运行历史清理使用上方固定的 {days} 天和最近 {runs} 次安全策略。" }, { days: formatNumber(30), runs: formatNumber(100) })}</p>
      </section>
      {actionError && <p role="alert" className="settings-error">{t({ en: "Maintenance action failed:", "zh-CN": "维护操作失败：" })} {actionError instanceof Error ? actionError.message : String(actionError)}</p>}
      {message && <p role="status" className="settings-message">{t(message.message, message.values)}</p>}
    </section>
  );
}
