import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
  cancelRepositoryOnboarding,
  createRepositoryOnboarding,
  fetchRepositorySettings,
  fetchRepositoryOnboarding,
  retryRepositoryOnboarding,
  updateRepositorySettings,
  type RepositoryOnboarding,
} from "../../settings-client";
import { RepositoryRetentionSection } from "./RepositoryRetentionSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { ErrorText } from "./settings-helpers";
import { useI18n, type I18nContextValue } from "../../i18n";

const activeRunStatuses = new Set<SyncRun["status"]>(["queued", "running"]);

export const DEFAULT_REPOSITORY_WORKTREE_SLOTS = 10;
export const DEFAULT_REPOSITORY_SYNC_LOOKBACK_DAYS = 7;

export function repositoryDefaultsFromUrl(value: string) {
  const input = value.trim().replace(/\/$/, "");
  let owner = "";
  let name = "";
  const ssh = input.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) [, owner, name] = ssh;
  else {
    try {
      const parsed = new URL(input);
      if (parsed.hostname.toLowerCase() !== "github.com") return null;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      [owner, name] = parts;
      name = name.replace(/\.git$/i, "");
    } catch {
      const shorthand = input.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
      if (shorthand) [, owner, name] = shorthand;
    }
  }
  if (!owner || !name) return null;
  const key = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    owner,
    name,
    key,
    displayName: name,
    remoteName: "upstream",
    defaultBranch: "main",
    worktreeSlots: DEFAULT_REPOSITORY_WORKTREE_SLOTS,
    syncLookbackDays: DEFAULT_REPOSITORY_SYNC_LOOKBACK_DAYS as 7,
  };
}

const onboardingSteps = [
  ["validating", { en: "Validate", "zh-CN": "验证" }],
  ["cloning", { en: "Clone or reuse", "zh-CN": "克隆 / 复用" }],
  ["registering", { en: "Register", "zh-CN": "注册" }],
  ["initializing", { en: "Initialize", "zh-CN": "初始化" }],
  ["syncing", { en: "First sync", "zh-CN": "首次同步" }],
  ["ready", { en: "Ready", "zh-CN": "可用" }],
] as const;

const onboardingStatusLabels = {
  queued: { en: "Queued", "zh-CN": "排队中" },
  validating: { en: "Validate", "zh-CN": "验证" },
  cloning: { en: "Clone or reuse", "zh-CN": "克隆 / 复用" },
  registering: { en: "Register", "zh-CN": "注册" },
  initializing: { en: "Initialize", "zh-CN": "初始化" },
  syncing: { en: "First sync", "zh-CN": "首次同步" },
  ready: { en: "Ready", "zh-CN": "可用" },
  failed: { en: "Failed", "zh-CN": "失败" },
  cancelled: { en: "Cancelled", "zh-CN": "已取消" },
} as const;

const onboardingStorageKey = "loongboard.repository-onboarding.jobId";

function readStoredOnboardingJobId(): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(onboardingStorageKey);
  } catch {
    return null;
  }
}

function storeOnboardingJobId(jobId: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (jobId === null) window.sessionStorage.removeItem(onboardingStorageKey);
    else window.sessionStorage.setItem(onboardingStorageKey, jobId);
  } catch {
    // Session storage may be disabled; the in-memory state still works.
  }
}

export function onboardingFailure(t: I18nContextValue["t"], error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const duplicate = detail.match(/Repository key or GitHub repository is already configured:\s*(.+)$/);
  if (duplicate?.[1]) {
    return t(
      {
        en: "Repository onboarding failed: This GitHub repository or repository key is already connected ({target}).",
        "zh-CN": "仓库接入失败：该 GitHub 仓库或仓库键已接入（{target}）。",
      },
      { target: duplicate[1] },
    );
  }
  return `${t({ en: "Repository onboarding failed:", "zh-CN": "仓库接入失败：" })} ${detail}`;
}

export function OnboardingProgress({ job, onRetry, onCancel, onSync, retrying, cancelling }: {
  job: RepositoryOnboarding;
  onRetry: () => void;
  onCancel: () => void;
  onSync?: () => void;
  retrying: boolean;
  cancelling: boolean;
}) {
  const { t } = useI18n();
  const current = job.status === "queued" ? 0 : onboardingSteps.findIndex(([status]) => status === job.status);
  const active = !["ready", "failed", "cancelled"].includes(job.status);
  const currentLabel = onboardingStatusLabels[job.status];
  return <section className="repository-onboarding-progress" aria-live="polite" aria-labelledby="repository-onboarding-progress-heading">
    <header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Repository onboarding", "zh-CN": "仓库接入" })}</p><h3 id="repository-onboarding-progress-heading">{t({ en: "Setting up your repository", "zh-CN": "正在设置仓库" })}</h3></div><span className={`status-pill status-pill--${job.status}`}>{t(currentLabel)}</span></header>
    <ol className="repository-onboarding-steps" aria-label={t({ en: "Repository onboarding steps", "zh-CN": "仓库接入步骤" })}>
      {onboardingSteps.map(([status, label], index) => { const complete = index < current || job.status === "ready"; const currentStep = index === current && !complete; return <li key={status} className={complete ? "is-complete" : currentStep ? "is-current" : ""} aria-current={currentStep ? "step" : undefined} aria-label={`${t(label)}: ${t(complete ? { en: "completed", "zh-CN": "已完成" } : currentStep ? { en: "current", "zh-CN": "当前" } : { en: "pending", "zh-CN": "待处理" })}`}><span aria-hidden="true">{complete ? "✓" : index + 1}</span>{t(label)}</li>; })}
    </ol>
    <progress aria-label={t({ en: "Repository onboarding progress", "zh-CN": "仓库接入进度" })} value={job.progress} max={100}>{job.progress}%</progress>
    <p className="settings-neutral">{t({ en: "Current step: {step}", "zh-CN": "当前步骤：{step}" }, { step: t(currentLabel) })}</p>
    {job.detail && <p className={job.status === "failed" ? "settings-error" : "settings-muted"}>{job.status === "failed" ? onboardingFailure(t, job.detail) : job.detail}</p>}
    {job.githubMetadataPending && <p role="status" className="settings-neutral">{t({ en: "Code is connected; GitHub metadata is waiting for credentials.", "zh-CN": "代码已接入，GitHub 元数据等待凭据。" })} <Link to="/settings/integrations">{t({ en: "Configure GitHub access", "zh-CN": "配置 GitHub 访问" })}</Link></p>}
    {(job.status === "failed" || job.status === "cancelled" || (job.status === "ready" && job.githubMetadataPending)) && <div className="settings-form-row"><button type="button" onClick={onRetry} disabled={retrying}>{retrying ? t({ en: "Continuing…", "zh-CN": "继续中…" }) : job.status === "ready" && job.githubMetadataPending ? t({ en: "Credentials configured — continue first sync", "zh-CN": "凭据已配置——继续首次同步" }) : t({ en: "Retry", "zh-CN": "重试" })}</button></div>}
    {job.status === "ready" && job.repositoryId && <div className="settings-form-row"><Link className="button-link" to={`/repositories/${encodeURIComponent(job.repositoryId)}`}>{t({ en: "Open repository", "zh-CN": "进入仓库" })}</Link>{onSync && <button type="button" className="button-primary" onClick={onSync}>{t({ en: "Sync now", "zh-CN": "立即同步" })}</button>}</div>}
    {active && <button type="button" className="button-danger" onClick={onCancel} disabled={cancelling}>{cancelling ? t({ en: "Cancelling…", "zh-CN": "取消中…" }) : t({ en: "Cancel", "zh-CN": "取消" })}</button>}
  </section>;
}

export function RepositoryOnboardingCard() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [githubUrl, setGithubUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [jobId, setJobId] = useState<string | null>(readStoredOnboardingJobId);
  const [editedFields, setEditedFields] = useState({ displayName: false, key: false });
  const [form, setForm] = useState(() => ({ displayName: "", key: "", remoteName: "upstream", defaultBranch: "main", worktreeSlots: DEFAULT_REPOSITORY_WORKTREE_SLOTS }));
  const defaults = repositoryDefaultsFromUrl(githubUrl);
  const job = useQuery({ queryKey: ["repository-onboarding", jobId], enabled: jobId !== null, queryFn: ({ signal }) => fetchRepositoryOnboarding(jobId as string, signal), refetchInterval: (query) => {
    const status = query.state.data?.status;
    return status && ["ready", "failed", "cancelled"].includes(status) ? false : 1_000;
  } });
  const create = useMutation({ mutationFn: () => createRepositoryOnboarding({ url: githubUrl.trim(), ...(form.displayName ? { displayName: form.displayName } : {}), ...(form.key ? { key: form.key } : {}), remote: form.remoteName, defaultBranch: form.defaultBranch, worktreeSlots: form.worktreeSlots }), onSuccess: ({ jobId: next }) => setJobId(next) });
  const retry = useMutation({ mutationFn: () => retryRepositoryOnboarding(jobId as string), onSuccess: ({ jobId: next }) => { setJobId(next); void client.invalidateQueries({ queryKey: ["repository-onboarding", next] }); } });
  const cancel = useMutation({ mutationFn: () => cancelRepositoryOnboarding(jobId as string), onSuccess: (next) => client.setQueryData(["repository-onboarding", jobId], next) });
  const sync = useMutation({ mutationFn: () => startSync(job.data?.repositoryId as string), onSuccess: () => { void client.invalidateQueries({ queryKey: ["sync", job.data?.repositoryId] }); } });
  const terminalJob = job.data !== undefined && ["ready", "failed", "cancelled"].includes(job.data.status);
  const activeJob = jobId !== null && !terminalJob && !job.isError;
  useEffect(() => {
    if (!defaults) return;
    setForm((current) => ({ ...current, displayName: editedFields.displayName ? current.displayName : defaults.displayName, key: editedFields.key ? current.key : defaults.key }));
  }, [defaults?.displayName, defaults?.key, editedFields.displayName, editedFields.key]);
  useEffect(() => {
    if (jobId !== null) storeOnboardingJobId(jobId);
  }, [jobId]);
  useEffect(() => {
    if (job.data?.status !== "ready") return;
    void client.invalidateQueries({ queryKey: ["repositories"] });
    void client.invalidateQueries({ queryKey: ["repository-settings"] });
    void client.invalidateQueries({ queryKey: ["sync"] });
    void client.invalidateQueries({ queryKey: ["sync-history"] });
    void client.invalidateQueries({ queryKey: ["sync-runs"] });
  }, [client, job.data?.status]);
  const localError = githubUrl.length > 0 && !defaults ? t({ en: "Enter a GitHub URL such as owner/repo.", "zh-CN": "请输入 GitHub 地址，例如 owner/repo。" }) : null;
  const actionError = create.error ?? retry.error ?? cancel.error ?? job.error;
  const update = (field: "displayName" | "key" | "remoteName" | "defaultBranch" | "worktreeSlots", value: string | number) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (field === "displayName" || field === "key") setEditedFields((current) => ({ ...current, [field]: true }));
  };
  const resetOnboarding = () => {
    setGithubUrl("");
    setAdvanced(false);
    setJobId(null);
    storeOnboardingJobId(null);
    setEditedFields({ displayName: false, key: false });
    setForm({ displayName: "", key: "", remoteName: "upstream", defaultBranch: "main", worktreeSlots: DEFAULT_REPOSITORY_WORKTREE_SLOTS });
  };
  return <article className="settings-card repository-onboarding-card">
    <header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Connect a repository", "zh-CN": "接入仓库" })}</p><h3>{t({ en: "Connect GitHub repository", "zh-CN": "接入 GitHub 仓库" })}</h3><p className="settings-muted">{t({ en: "Enter a GitHub URL. The server performs the final validation and initializes sync, domains, schedules, and worktrees.", "zh-CN": "输入 GitHub 地址。服务器将完成最终验证，并初始化同步、领域、计划任务和工作树。" })}</p></div></header>
    <form className="repository-onboarding-form" onSubmit={(event) => { event.preventDefault(); if (!defaults || create.isPending || activeJob) return; create.mutate(); }}>
      <label>{t({ en: "GitHub URL", "zh-CN": "GitHub 地址" })}<input disabled={activeJob} value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repo" autoComplete="url" /></label>
      {defaults && <p className="settings-muted">{defaults.owner}/{defaults.name} · {t({ en: "7-day initial sync · 10 worktree slots", "zh-CN": "初始同步 7 天 · 10 个工作树槽位" })}</p>}
      {localError && <p role="alert" className="settings-error">{localError}</p>}
      <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>{t({ en: "Advanced settings", "zh-CN": "高级设置" })}</summary><div className="settings-grid"><label>{t({ en: "Display name", "zh-CN": "显示名称" })}<input disabled={activeJob} value={form.displayName} onChange={(event) => update("displayName", event.target.value)} /></label><label>{t({ en: "Repository key", "zh-CN": "仓库键" })}<input disabled={activeJob} value={form.key} onChange={(event) => update("key", event.target.value)} /></label><label>{t({ en: "Remote name", "zh-CN": "远端名称" })}<input disabled={activeJob} value={form.remoteName} onChange={(event) => update("remoteName", event.target.value)} /></label><label>{t({ en: "Default branch", "zh-CN": "默认分支" })}<input disabled={activeJob} value={form.defaultBranch} onChange={(event) => update("defaultBranch", event.target.value)} /></label><label>{t({ en: "Worktree slots", "zh-CN": "工作树槽位" })}<select disabled={activeJob} value={form.worktreeSlots} onChange={(event) => update("worktreeSlots", Number(event.target.value))}>{Array.from({ length: 16 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}</select></label><p className="settings-muted">{t({ en: "Initial sync window: 7 days", "zh-CN": "初始同步窗口：7 天" })}</p></div></details>
      {actionError && <p role="alert" className="settings-error">{onboardingFailure(t, actionError)}</p>}
      <button type="submit" className="button-primary" disabled={!defaults || create.isPending || activeJob}>{create.isPending ? t({ en: "Starting…", "zh-CN": "启动中…" }) : t({ en: "Connect repository", "zh-CN": "接入仓库" })}</button>
    </form>
    {job.data && <><OnboardingProgress job={job.data} onRetry={() => retry.mutate()} onCancel={() => cancel.mutate()} onSync={job.data.repositoryId ? () => sync.mutate() : undefined} retrying={retry.isPending} cancelling={cancel.isPending} />{terminalJob && <button type="button" className="button-primary repository-onboarding-reset" onClick={resetOnboarding}>{t({ en: "Connect another repository", "zh-CN": "接入其他仓库" })}</button>}</>}
  </article>;
}

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
  enabled?: boolean;
}

function RepositorySettingsCard({
  repositoryId,
  name,
  githubOwner,
  githubName,
  localPath,
  pullRequestCount,
  issueCount,
  enabled = true,
}: RepositorySettingsCardProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["repository-settings", repositoryId], queryFn: () => fetchRepositorySettings(repositoryId) });
  const sync = useQuery({ queryKey: ["sync", repositoryId], queryFn: ({ signal }) => fetchSyncStatus(repositoryId, signal), refetchInterval: 5_000 });
  const [frequency, setFrequency] = useState(60);
  const [automatic, setAutomatic] = useState(true);
  const [configuredSlots, setConfiguredSlots] = useState(DEFAULT_REPOSITORY_WORKTREE_SLOTS);
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
    setConfiguredSlots(state.worktrees?.configuredSlots ?? DEFAULT_REPOSITORY_WORKTREE_SLOTS);
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
    <header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Repository", "zh-CN": "仓库" })}</p><h3>{name}</h3><p className="settings-muted">{repositoryId}</p></div><div className="settings-status-group"><span className={`status-pill status-pill--${enabled ? (sync.data?.status ?? "unknown") : "disabled"}`}>{enabled ? (sync.data?.status ?? "unknown") : t({ en: "Disabled", "zh-CN": "已停用" })}</span>{!enabled && <span className="settings-muted">{t({ en: "Lifecycle controls are unavailable until the server enables them.", "zh-CN": "服务器启用生命周期控制后可重新启用。" })}</span>}</div></header>
    <dl className="settings-details"><div><dt>{t({ en: "GitHub repository", "zh-CN": "GitHub 仓库" })}</dt><dd>{githubOwner}/{githubName}</dd></div><div><dt>{t({ en: "Local path", "zh-CN": "本地路径" })}</dt><dd>{localPath}</dd></div><div><dt>{t({ en: "Repository key", "zh-CN": "仓库键" })}</dt><dd>{repositoryId}</dd></div></dl><div className="settings-metrics"><div><span>{t({ en: "Last successful sync", "zh-CN": "上次成功同步" })}</span><strong>{latest ? formatDateTime(latest) : t({ en: "No successful sync", "zh-CN": "没有成功同步" })}</strong></div><div><span>{t({ en: "Next automatic sync", "zh-CN": "下次自动同步" })}</span><strong>{state?.nextSyncAt ? formatDateTime(state.nextSyncAt) : t({ en: "Not scheduled", "zh-CN": "未计划" })}</strong></div><div><span>{t({ en: "Recent error", "zh-CN": "最近错误" })}</span><strong>{stream?.lastError ?? sync.data?.issues.lastError ?? t({ en: "None", "zh-CN": "无" })}</strong></div></div>
    <p className="settings-sync-scope"><strong>{t({ en: "Live sync follows the forward watermark for new and changed PRs and issues.", "zh-CN": "实时同步遵循新建和变更 PR 及 Issue 的前向水位线。" })}</strong> {t({ en: "Historical coverage is configured below in History and continues toward its selected target.", "zh-CN": "历史覆盖在下方的历史区域配置，并持续向选定目标推进。" })}<br /><span>{t({ en: "Stored locally:", "zh-CN": "本地存储：" })} {localCounts}</span></p>
    {settings.isError && <ErrorText error={settings.error} />}
    {sync.isError && <ErrorText error={sync.error} />}
    {save.isError && <ErrorText error={save.error} />}
    {run.isError && <ErrorText error={run.error} />}
    {save.isSuccess && <p role="status" className="settings-message">{t({ en: "Repository sync settings saved.", "zh-CN": "仓库同步设置已保存。" })}</p>}
    <div className="settings-form-row"><SettingsSwitch label={t({ en: "Automatic sync", "zh-CN": "自动同步" })} checked={automatic} onChange={setAutomatic} /><label>{t({ en: "Every", "zh-CN": "每" })} <select value={frequency} onChange={(event) => setFrequency(Number(event.target.value))}><option value={15}>{t({ en: "{count} minutes", "zh-CN": "{count} 分钟" }, { count: formatNumber(15) })}</option><option value={60}>{t({ en: "{count} hour", "zh-CN": "{count} 小时" }, { count: formatNumber(1) })}</option><option value={360}>{t({ en: "{count} hours", "zh-CN": "{count} 小时" }, { count: formatNumber(6) })}</option><option value={1440}>{t({ en: "Daily", "zh-CN": "每天" })}</option></select></label><button type="button" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save", "zh-CN": "保存" })}</button><button type="button" className="button-primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? t({ en: "Starting…", "zh-CN": "启动中…" }) : t({ en: "Sync now", "zh-CN": "立即同步" })}</button><Link className="button-link" to={`/repositories/${encodeURIComponent(repositoryId)}`}>{t({ en: "Open repository", "zh-CN": "进入仓库" })}</Link></div>
    <section className="settings-subsection" aria-labelledby={`worktrees-${repositoryId}`}><header className="settings-card__header"><div><p className="eyebrow">{t({ en: "Workspace isolation", "zh-CN": "工作区隔离" })}</p><h4 id={`worktrees-${repositoryId}`}>{t({ en: "Worktrees", "zh-CN": "工作树" })}</h4><p className="settings-muted">{t({ en: "Capacity is per repository and does not limit Agent global concurrency.", "zh-CN": "容量按仓库计算，不限制智能代理全局并发。" })}</p></div></header><div className="settings-grid"><label>{t({ en: "Maximum slots", "zh-CN": "最大槽位" })}<select value={configuredSlots} onChange={(event) => setConfiguredSlots(Number(event.target.value))}>{Array.from({ length: 16 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{formatNumber(count)}</option>)}</select></label><label>{t({ en: "Idle cleanup TTL", "zh-CN": "空闲清理 TTL" })}<select value={idleCleanupTtlHours} onChange={(event) => setIdleCleanupTtlHours(Number(event.target.value))}><option value={6}>{formatNumber(6)} {t({ en: "hours", "zh-CN": "小时" })}</option><option value={24}>{formatNumber(24)} {t({ en: "hours", "zh-CN": "小时" })}</option><option value={72}>{formatNumber(3)} {t({ en: "days", "zh-CN": "天" })}</option><option value={168}>{formatNumber(7)} {t({ en: "days", "zh-CN": "天" })}</option><option value={720}>{formatNumber(30)} {t({ en: "days", "zh-CN": "天" })}</option></select></label></div><dl className="settings-details"><div><dt>{t({ en: "Configured / physical", "zh-CN": "配置 / 物理" })}</dt><dd>{worktrees?.configuredSlots !== undefined ? formatNumber(worktrees.configuredSlots) : formatNumber(configuredSlots)} / {worktrees?.physicalSlots !== undefined ? formatNumber(worktrees.physicalSlots) : formatNumber(0)}</dd></div><div><dt>{t({ en: "Active / idle", "zh-CN": "活动 / 空闲" })}</dt><dd>{formatNumber(worktrees?.active ?? 0)} / {formatNumber(worktrees?.idle ?? 0)}</dd></div><div><dt>{t({ en: "Dirty", "zh-CN": "有改动" })}</dt><dd>{formatNumber(worktrees?.dirty ?? 0)}</dd></div><div><dt>{t({ en: "Pending retirement", "zh-CN": "待回收" })}</dt><dd>{formatNumber(worktrees?.pendingRetirement ?? 0)}</dd></div></dl><div className="settings-form-row"><button type="button" onClick={() => cleanup.mutate()} disabled={cleanup.isPending}>{cleanup.isPending ? t({ en: "Cleaning…", "zh-CN": "清理中…" }) : t({ en: "Clean unused now", "zh-CN": "立即清理未使用项" })}</button></div>{cleanup.isError && <ErrorText error={cleanup.error} />}</section>
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
  return <div className="settings-stack"><RepositoryOnboardingCard />{repositories.data.items.map((repository) => <RepositorySettingsCard key={repository.id} repositoryId={repository.id} name={repository.displayName} githubOwner={repository.githubOwner} githubName={repository.githubName} localPath={repository.localPath} pullRequestCount={repository.pullRequestCount} issueCount={repository.issueCount} enabled={repository.enabled} />)}{repositories.data.items.length === 0 && <p role="status">{t({ en: "No configured repositories yet. Connect one above to get started.", "zh-CN": "还没有已配置的仓库。请在上方接入仓库。" })}</p>}</div>;
}

export { RepositorySettingsSection as RepositoriesSettings };
