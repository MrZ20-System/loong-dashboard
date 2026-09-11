import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SyncRun } from "@loongboard/contracts";
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
  cleanupRepositoryWorktrees,
  fetchRepositorySettings,
  updateRepositorySettings,
} from "../../settings-client";
import { RepositoryRetentionSection } from "./RepositoryRetentionSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";
import { useI18n, type I18nContextValue } from "../../i18n";

const activeRunStatuses = new Set<SyncRun["status"]>(["queued", "running"]);

function isActiveRun(run: SyncRun | undefined): boolean {
  return run !== undefined && activeRunStatuses.has(run.status);
}

function syncRunTarget(run: SyncRun, t: I18nContextValue["t"], formatNumber: I18nContextValue["formatNumber"], formatDate: I18nContextValue["formatDate"]): string {
  const selector = run.selector;
  const targetDate = selector.targetDate;
  if (typeof targetDate === "string") return formatDate(targetDate, undefined, "UTC");
  const from = selector.from;
  const to = selector.to;
  if (typeof from === "string" && typeof to === "string") return `${formatDate(from, undefined, "UTC")} – ${formatDate(to, undefined, "UTC")}`;
  if (typeof selector.number === "number") return t({ en: "PR #{number}", "zh-CN": "PR #{number}" }, { number: formatNumber(selector.number) });
  return run.kind === "forward"
    ? t({ en: "Forward watermark", "zh-CN": "前向水位线" })
    : t({ en: "Target not specified", "zh-CN": "未指定目标" });
}

function syncRunDuration(run: SyncRun, t: I18nContextValue["t"], formatNumber: I18nContextValue["formatNumber"]): string {
  if (run.startedAt === null || run.finishedAt === null) return t({ en: "In progress", "zh-CN": "进行中" });
  const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(elapsed)
    ? t({ en: "{seconds}s", "zh-CN": "{seconds} 秒" }, { seconds: formatNumber(Math.max(0, Math.round(elapsed / 1000))) })
    : t({ en: "Duration unavailable", "zh-CN": "时长不可用" });
}

export function HistorySyncSection({ repositoryId }: { repositoryId: string }) {
  const { t, formatDate, formatDateTime, formatNumber } = useI18n();
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
    ? t({ en: "Covered through {date}", "zh-CN": "覆盖至 {date}" }, { date: formatDate(pullHistory.oldestCoveredDay, undefined, "UTC") })
    : t({ en: "No historical coverage yet", "zh-CN": "还没有历史覆盖" });

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
          <p className="eyebrow">{t({ en: "Historical PR coverage", "zh-CN": "PR 历史覆盖" })}</p>
          <h4 id={`history-${repositoryId}`}>{t({ en: "History", "zh-CN": "历史" })}</h4>
          <p className="settings-muted">{t({ en: "Set a historical target and keep backfilling in bounded runs until coverage reaches it. Forward sync and history keep separate watermarks.", "zh-CN": "设置历史目标，并通过有界运行持续回填直到达到目标。前向同步和历史记录使用独立水位线。" })}</p>
        </div>
        <span className={`status-pill status-pill--${status}`}>{status}</span>
      </header>
      {history.isError && <ErrorText error={history.error} />}
      {recentRuns.isError && <ErrorText error={recentRuns.error} />}
      {actionError && <ErrorText error={actionError} />}
      <div className="settings-history-summary">
        <div><span>{t({ en: "Target date", "zh-CN": "目标日期" })}</span><strong>{formatDate(effectiveTargetDate, undefined, "UTC")}</strong></div>
        <div><span>{t({ en: "Oldest covered", "zh-CN": "最早覆盖" })}</span><strong>{pullHistory?.oldestCoveredDay ? formatDate(pullHistory.oldestCoveredDay, undefined, "UTC") : t({ en: "Not covered", "zh-CN": "未覆盖" })}</strong></div>
        <div><span>{t({ en: "Progress", "zh-CN": "进度" })}</span><strong>{progress}</strong></div>
        <div><span>{t({ en: "Last error", "zh-CN": "上次错误" })}</span><strong>{displayedError ?? t({ en: "None", "zh-CN": "无" })}</strong></div>
      </div>
      <div className="settings-form-row history-sync-controls">
        <label>{t({ en: "Backfill through", "zh-CN": "回填至" })}<input aria-label={t({ en: "History target date", "zh-CN": "历史目标日期" })} type="date" value={effectiveTargetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -6))} disabled={start.isPending || continueRun.isPending}>{t({ en: "Backfill {count} days", "zh-CN": "回填 {count} 天" }, { count: formatNumber(7) })}</button>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -29))} disabled={start.isPending || continueRun.isPending}>{t({ en: "Backfill {count} days", "zh-CN": "回填 {count} 天" }, { count: formatNumber(30) })}</button>
        <button type="button" onClick={() => start.mutate(shiftDay(todayValue(), -89))} disabled={start.isPending || continueRun.isPending}>{t({ en: "Backfill {count} days", "zh-CN": "回填 {count} 天" }, { count: formatNumber(90) })}</button>
        <button type="button" className="button-primary" onClick={() => start.mutate(effectiveTargetDate)} disabled={start.isPending || pause.isPending}>{start.isPending ? t({ en: "Starting…", "zh-CN": "启动中…" }) : t({ en: "Enable and start", "zh-CN": "启用并启动" })}</button>
        {status === "paused" || status === "failed" ? <button type="button" onClick={() => continueRun.mutate()} disabled={continueRun.isPending}>{continueRun.isPending ? t({ en: "Continuing…", "zh-CN": "继续中…" }) : t({ en: "Continue", "zh-CN": "继续" })}</button> : <button type="button" onClick={() => pause.mutate()} disabled={pause.isPending || status === "idle"}>{pause.isPending ? t({ en: "Pausing…", "zh-CN": "暂停中…" }) : t({ en: "Pause", "zh-CN": "暂停" })}</button>}
      </div>
      {activeRun.data && isActiveRun(activeRun.data) && <p role="status" className="settings-message">{t({ en: "This history run is", "zh-CN": "此历史运行状态为" })} {activeRun.data.status}; {t({ en: "only this run is being checked.", "zh-CN": "当前仅检查此运行。" })}</p>}
      {activeRun.data && !isActiveRun(activeRun.data) && activeRun.data.error && <p role="alert" className="settings-error">{t({ en: "History run failed:", "zh-CN": "历史运行失败：" })} {activeRun.data.error}</p>}
      <section className="settings-history-runs" aria-labelledby={`recent-syncs-${repositoryId}`}>
        <h5 id={`recent-syncs-${repositoryId}`}>{t({ en: "Recent syncs", "zh-CN": "最近同步" })}</h5>
        {recentRuns.isPending ? <p role="status">{t({ en: "Loading recent syncs…", "zh-CN": "正在加载最近同步…" })}</p> : recentRuns.data?.items.length === 0 ? <p className="settings-muted">{t({ en: "No sync runs yet.", "zh-CN": "还没有同步运行。" })}</p> : (
          <ul>
            {(recentRuns.data?.items ?? []).map((run) => (
              <li key={run.syncRunId}>
                <span><strong>{run.kind === "fetch_pr" ? t({ en: "Fetch PR", "zh-CN": "获取 PR" }) : run.kind === "history" ? t({ en: "History", "zh-CN": "历史" }) : t({ en: "Forward", "zh-CN": "前向同步" })}</strong> · {t({ en: "target", "zh-CN": "目标" })} {syncRunTarget(run, t, formatNumber, formatDate)} · {t({ en: "requested", "zh-CN": "请求于" })} {formatDateTime(run.requestedAt)}</span>
                <span className={`status-pill status-pill--${run.status}`}>{run.status}</span>
                <span>{t({ en: "{seen} processed · {written} changed · started {started} · finished {finished} · {duration}", "zh-CN": "{seen} 已处理 · {written} 已变更 · 开始 {started} · 结束 {finished} · {duration}" }, { seen: formatNumber(run.itemsSeen), written: formatNumber(run.itemsWritten), started: run.startedAt ? formatDateTime(run.startedAt) : "—", finished: run.finishedAt ? formatDateTime(run.finishedAt) : "—", duration: syncRunDuration(run, t, formatNumber) })}</span>
                {run.error && <span className="settings-error">{t({ en: "Error:", "zh-CN": "错误：" })} {run.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface RepositorySettingsCardProps {
  repositoryId: string;
  name: string;
  githubOwner: string;
  githubName: string;
  localPath: string;
  pullRequestCount?: number;
  issueCount?: number;
}

function RepositorySettingsCard({
  repositoryId,
  name,
  githubOwner,
  githubName,
  localPath,
  pullRequestCount,
  issueCount,
}: RepositorySettingsCardProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
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
  const worktrees = state?.worktrees;
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
    ? t({ en: "{pullRequests} PR · {issues} issues", "zh-CN": "{pullRequests} PR · {issues} 个 Issue" }, { pullRequests: pullRequestCount === undefined ? "—" : formatNumber(pullRequestCount), issues: issueCount === undefined ? "—" : formatNumber(issueCount) })
    : t({ en: "Unavailable", "zh-CN": "不可用" });

  return <article className="settings-card repository-settings-card">
    <header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Repository", "zh-CN": "仓库" })}</p><h3>{name}</h3><p className="settings-muted">{repositoryId}</p></div><span className={`status-pill status-pill--${sync.data?.status ?? "unknown"}`}>{sync.data?.status ?? "unknown"}</span></header>
    <dl className="settings-details"><div><dt>{t({ en: "GitHub repository", "zh-CN": "GitHub 仓库" })}</dt><dd>{githubOwner}/{githubName}</dd></div><div><dt>{t({ en: "Local path", "zh-CN": "本地路径" })}</dt><dd>{localPath}</dd></div><div><dt>{t({ en: "Repository key", "zh-CN": "仓库键" })}</dt><dd>{repositoryId}</dd></div></dl><div className="settings-metrics"><div><span>{t({ en: "Last successful sync", "zh-CN": "上次成功同步" })}</span><strong>{latest ? formatDateTime(latest) : t({ en: "No successful sync", "zh-CN": "没有成功同步" })}</strong></div><div><span>{t({ en: "Next automatic sync", "zh-CN": "下次自动同步" })}</span><strong>{state?.nextSyncAt ? formatDateTime(state.nextSyncAt) : t({ en: "Not scheduled", "zh-CN": "未计划" })}</strong></div><div><span>{t({ en: "Recent error", "zh-CN": "最近错误" })}</span><strong>{stream?.lastError ?? sync.data?.issues.lastError ?? t({ en: "None", "zh-CN": "无" })}</strong></div></div>
    <p className="settings-sync-scope"><strong>{t({ en: "Live sync follows the forward watermark for new and changed PRs and issues.", "zh-CN": "实时同步遵循新建和变更 PR 及 Issue 的前向水位线。" })}</strong> {t({ en: "Historical coverage is configured below in History and continues toward its selected target.", "zh-CN": "历史覆盖在下方的历史区域配置，并持续向选定目标推进。" })}<br /><span>{t({ en: "Stored locally:", "zh-CN": "本地存储：" })} {localCounts}</span></p>
    {settings.isError && <ErrorText error={settings.error} />}
    {sync.isError && <ErrorText error={sync.error} />}
    {save.isError && <ErrorText error={save.error} />}
    {run.isError && <ErrorText error={run.error} />}
    {save.isSuccess && <p role="status" className="settings-message">{t({ en: "Repository sync settings saved.", "zh-CN": "仓库同步设置已保存。" })}</p>}
    <div className="settings-form-row"><SettingsSwitch label={t({ en: "Automatic sync", "zh-CN": "自动同步" })} checked={automatic} onChange={setAutomatic} /><label>{t({ en: "Every", "zh-CN": "每" })} <select value={frequency} onChange={(event) => setFrequency(Number(event.target.value))}><option value={15}>{t({ en: "{count} minutes", "zh-CN": "{count} 分钟" }, { count: formatNumber(15) })}</option><option value={60}>{t({ en: "{count} hour", "zh-CN": "{count} 小时" }, { count: formatNumber(1) })}</option><option value={360}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(6) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label><button type="button" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save", "zh-CN": "保存" })}</button><button type="button" className="button-primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? t({ en: "Starting…", "zh-CN": "启动中…" }) : t({ en: "Sync now", "zh-CN": "立即同步" })}</button></div>
    <section className="settings-subsection" aria-labelledby={`worktrees-${repositoryId}`}><header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Workspace isolation", "zh-CN": "工作区隔离" })}</p><h4 id={`worktrees-${repositoryId}`}>{t({ en: "Worktrees", "zh-CN": "工作树" })}</h4><p className="settings-muted">{t({ en: "Capacity is per repository and does not limit Agent global concurrency.", "zh-CN": "容量按仓库计算，不限制智能代理全局并发。" })}</p></div></header><div className="settings-grid"><label>{t({ en: "Maximum slots", "zh-CN": "最大槽位" })}<select value={configuredSlots} onChange={(event) => setConfiguredSlots(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{formatNumber(count)}</option>)}</select></label><label>{t({ en: "Idle cleanup TTL", "zh-CN": "空闲清理 TTL" })}<select value={idleCleanupTtlHours} onChange={(event) => setIdleCleanupTtlHours(Number(event.target.value))}><option value={6}>{formatNumber(6)} {t({ en: "hours", "zh-CN": "小时" })}</option><option value={24}>{formatNumber(24)} {t({ en: "hours", "zh-CN": "小时" })}</option><option value={72}>{formatNumber(3)} {t({ en: "days", "zh-CN": "天" })}</option><option value={168}>{formatNumber(7)} {t({ en: "days", "zh-CN": "天" })}</option><option value={720}>{formatNumber(30)} {t({ en: "days", "zh-CN": "天" })}</option></select></label></div><dl className="settings-details"><div><dt>{t({ en: "Configured / physical", "zh-CN": "配置 / 物理" })}</dt><dd>{worktrees?.configuredSlots !== undefined ? formatNumber(worktrees.configuredSlots) : formatNumber(configuredSlots)} / {worktrees?.physicalSlots !== undefined ? formatNumber(worktrees.physicalSlots) : formatNumber(0)}</dd></div><div><dt>{t({ en: "Active / idle", "zh-CN": "活动 / 空闲" })}</dt><dd>{formatNumber(worktrees?.active ?? 0)} / {formatNumber(worktrees?.idle ?? 0)}</dd></div><div><dt>{t({ en: "Dirty", "zh-CN": "有改动" })}</dt><dd>{formatNumber(worktrees?.dirty ?? 0)}</dd></div><div><dt>{t({ en: "Pending retirement", "zh-CN": "待回收" })}</dt><dd>{formatNumber(worktrees?.pendingRetirement ?? 0)}</dd></div></dl><div className="settings-form-row"><button type="button" onClick={() => cleanup.mutate()} disabled={cleanup.isPending}>{cleanup.isPending ? t({ en: "Cleaning…", "zh-CN": "清理中…" }) : t({ en: "Clean unused now", "zh-CN": "立即清理未使用项" })}</button></div>{cleanup.isError && <ErrorText error={cleanup.error} />}</section>
    <HistorySyncSection repositoryId={repositoryId} />
    <RepositoryRetentionSection repositoryId={repositoryId} />
    {run.isPending && <p role="status" className="settings-message">{t({ en: "Sync started. Fetching recent history for new repositories and updates for existing ones.", "zh-CN": "同步已开始。正在为新仓库获取近期历史并更新已有仓库。" })}</p>}
    {run.isSuccess && !run.isPending && <p role="status" className="settings-message">{t({ en: "Sync started.", "zh-CN": "同步已开始。" })}</p>}
  </article>;
}

export function RepositorySettingsSection() {
  const { t } = useI18n();
  const repositories = useRepositories();
  if (repositories.isPending) return <p role="status">{t({ en: "Loading repositories…", "zh-CN": "正在加载仓库…" })}</p>;
  if (repositories.isError) return <ErrorText error={repositories.error} />;
  return <div className="settings-stack">{repositories.data.items.map((repository) => <RepositorySettingsCard key={repository.id} repositoryId={repository.id} name={repository.displayName} githubOwner={repository.githubOwner} githubName={repository.githubName} localPath={repository.localPath} pullRequestCount={repository.pullRequestCount} issueCount={repository.issueCount} />)}{repositories.data.items.length === 0 && <p role="status">{t({ en: "No configured repositories.", "zh-CN": "没有已配置的仓库。" })}</p>}</div>;
}

export { RepositorySettingsSection as RepositoriesSettings };
