import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchPersonalDataSettings,
  importPersonalData,
  pushPersonalData,
  refreshPersonalDataInstructionTree,
  runPersonalDataCheckpoint,
  updatePersonalDataSettings,
  type PersonalDataSettings,
} from "../../settings-client";
import { SettingsSwitch } from "./SettingsSwitch";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";
import { ErrorText } from "./settings-helpers";
import { CronField } from "./CronField";

type Feedback = { message: LocalizedMessage; values?: MessageValues; tone?: "error" | "success" };

const DEFAULT_BRANCH = "profile/z20";
const DEFAULT_CHECKPOINT_CRON = "0 0 * * *";
const DEFAULT_PUSH_CRON = "0 0 * * *";
const DEFAULT_SETTINGS: PersonalDataSettings = {
  path: "",
  knowledgePath: "",
  instructionTreePath: "",
  available: false,
  automaticCheckpoint: false,
  automaticPush: false,
  remote: "origin",
  sourceRef: "main",
  remoteBranch: "loongboard-personal-data-backup",
  checkpointCron: DEFAULT_CHECKPOINT_CRON,
  pushCron: DEFAULT_PUSH_CRON,
  nextRunAt: null,
  lastSuccessAt: null,
  lastError: null,
};

const personalDataQueryKey = ["personal-data-settings"] as const;

export function PersonalDataSection() {
  const { t, formatDateTime } = useI18n();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: personalDataQueryKey,
    queryFn: fetchPersonalDataSettings,
    refetchInterval: 5_000,
  });
  const [draft, setDraft] = useState<Partial<PersonalDataSettings>>({});
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState(DEFAULT_BRANCH);
  const [message, setMessage] = useState<Feedback | null>(null);

  const importMutation = useMutation({
    mutationFn: () => importPersonalData({ repositoryUrl: repositoryUrl.trim(), branch: branch.trim() || DEFAULT_BRANCH }),
    onSuccess: () => {
      setRepositoryUrl("");
      setBranch(DEFAULT_BRANCH);
      setMessage({ message: { en: "Personal Data repository imported.", "zh-CN": "个人数据仓库已导入。" } });
      void client.invalidateQueries({ queryKey: personalDataQueryKey });
    },
    onError: (error: Error) => setMessage({ message: { en: "Import failed: {detail}", "zh-CN": "导入失败：{detail}" }, values: { detail: error.message }, tone: "error" }),
  });

  const refreshMutation = useMutation({
    mutationFn: refreshPersonalDataInstructionTree,
    onSuccess: () => setMessage({ message: { en: "Instruction Tree refreshed.", "zh-CN": "指令树已刷新。" } }),
    onError: (error: Error) => setMessage({ message: { en: "Refreshing the Instruction Tree failed: {detail}", "zh-CN": "刷新指令树失败：{detail}" }, values: { detail: error.message }, tone: "error" }),
  });

  const save = useMutation({
    mutationFn: () => updatePersonalDataSettings({
      ...draft,
      ...(draft.checkpointCron !== undefined ? { checkpointCron: draft.checkpointCron.trim() || DEFAULT_CHECKPOINT_CRON } : {}),
      ...(draft.pushCron !== undefined ? { pushCron: draft.pushCron.trim() || DEFAULT_PUSH_CRON } : {}),
    }),
    onSuccess: (data) => {
      client.setQueryData(personalDataQueryKey, data);
      setDraft({});
      setMessage({ message: { en: "Personal Data backup settings saved.", "zh-CN": "个人数据备份设置已保存。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving Personal Data backup settings failed: {detail}", "zh-CN": "保存个人数据备份设置失败：{detail}" }, values: { detail: error.message }, tone: "error" }),
  });

  const checkpoint = useMutation({
    mutationFn: runPersonalDataCheckpoint,
    onSuccess: () => {
      setMessage({ message: { en: "Personal Data checkpoint requested.", "zh-CN": "个人数据检查点请求已提交。" } });
      void client.invalidateQueries({ queryKey: personalDataQueryKey });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a Personal Data checkpoint failed: {detail}", "zh-CN": "请求个人数据检查点失败：{detail}" }, values: { detail: error.message }, tone: "error" }),
  });

  const push = useMutation({
    mutationFn: pushPersonalData,
    onSuccess: () => {
      setMessage({ message: { en: "Personal Data remote push requested.", "zh-CN": "个人数据远端推送请求已提交。" } });
      void client.invalidateQueries({ queryKey: personalDataQueryKey });
    },
    onError: (error: Error) => setMessage({ message: { en: "Requesting a Personal Data remote push failed: {detail}", "zh-CN": "请求个人数据远端推送失败：{detail}" }, values: { detail: error.message }, tone: "error" }),
  });

  const data = { ...DEFAULT_SETTINGS, ...query.data, ...draft };

  const updateDraft = <K extends keyof PersonalDataSettings>(key: K, value: PersonalDataSettings[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
  };

  return (
    <div className="settings-stack personal-data-settings">
      {message && <p aria-live="polite" role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "settings-error" : "settings-message"}>{t(message.message, message.values)}</p>}
      <section className="settings-card" aria-labelledby="personal-data-import-heading">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">{t({ en: "Personal Data", "zh-CN": "个人数据" })}</p>
            <h3 id="personal-data-import-heading">{t({ en: "Import Personal Data repository", "zh-CN": "导入个人数据仓库" })}</h3>
            <p>{t({ en: "Import initializes an empty local directory only. It does not pull, merge, or overwrite existing data.", "zh-CN": "导入仅初始化空的本地目录，不会拉取、合并或覆盖已有数据。" })}</p>
          </div>
        </header>
        {query.isPending && <p role="status" className="settings-neutral">{t({ en: "Loading local path…", "zh-CN": "正在加载本地路径…" })}</p>}
        {query.isError && <ErrorText error={query.error} />}
        <div className="settings-grid personal-data-import-grid">
          <label>{t({ en: "Repository URL", "zh-CN": "仓库地址" })}<input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/org/repo.git" autoComplete="off" /></label>
          <label>{t({ en: "Branch", "zh-CN": "分支" })}<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={DEFAULT_BRANCH} /></label>
          <label>{t({ en: "Local path (read-only)", "zh-CN": "本地路径（只读）" })}<input value={data.path || "—"} readOnly aria-readonly="true" /></label>
        </div>
        <div className="settings-form-row">
          <button type="button" className="button-primary" onClick={() => importMutation.mutate()} disabled={importMutation.isPending || repositoryUrl.trim().length === 0 || query.isPending}>
            {importMutation.isPending ? t({ en: "Importing…", "zh-CN": "导入中…" }) : t({ en: "Import repository", "zh-CN": "导入仓库" })}
          </button>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="instruction-tree-heading">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">{t({ en: "Instruction Tree", "zh-CN": "指令树" })}</p>
            <h3 id="instruction-tree-heading">{t({ en: "Refresh instruction tree", "zh-CN": "刷新指令树" })}</h3>
            <p>{t({ en: "Rebuilds prompts and skills into knowledge/_loongboard/instruction-tree.md and overwrites that file. This action does not checkpoint or push.", "zh-CN": "将 prompts 和 skills 重建到 knowledge/_loongboard/instruction-tree.md，并覆盖该文件。此操作不会创建检查点或推送。" })}</p>
          </div>
        </header>
        <div className="settings-form-row">
          <button type="button" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending || query.isPending}>
            {refreshMutation.isPending ? t({ en: "Refreshing…", "zh-CN": "刷新中…" }) : t({ en: "Refresh Instruction Tree", "zh-CN": "刷新指令树" })}
          </button>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="personal-data-backup-heading">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">{t({ en: "Personal Data Backup", "zh-CN": "个人数据备份" })}</p>
            <h3 id="personal-data-backup-heading">{t({ en: "Checkpoint and remote push", "zh-CN": "检查点和远端推送" })}</h3>
            <p>{t({ en: "Checkpoint and push use separate scheduler tasks and cadence.", "zh-CN": "检查点和推送使用独立的调度任务和频率。" })}</p>
          </div>
        </header>
        {query.isError && <ErrorText error={query.error} />}
        <div className="settings-grid">
          <div className="settings-switch-grid">
            <SettingsSwitch label={t({ en: "Automatic checkpoint", "zh-CN": "自动创建检查点" })} description={t({ en: "Create checkpoint commits on the configured cadence.", "zh-CN": "按配置频率创建检查点提交。" })} checked={data.automaticCheckpoint} onChange={(checked) => updateDraft("automaticCheckpoint", checked)} disabled={query.isPending} />
            <SettingsSwitch label={t({ en: "Automatic push", "zh-CN": "自动推送" })} description={t({ en: "Push completed checkpoints to the configured remote.", "zh-CN": "将完成的检查点推送到配置的远端。" })} checked={data.automaticPush} onChange={(checked) => updateDraft("automaticPush", checked)} disabled={query.isPending} />
          </div>
          <label>{t({ en: "Remote", "zh-CN": "远端" })}<input value={data.remote} onChange={(event) => updateDraft("remote", event.target.value)} /></label>
          <label>{t({ en: "Source ref", "zh-CN": "源 ref" })}<input value={data.sourceRef} onChange={(event) => updateDraft("sourceRef", event.target.value)} /></label>
          <label>{t({ en: "Remote backup branch", "zh-CN": "远端备份分支" })}<input value={data.remoteBranch} onChange={(event) => updateDraft("remoteBranch", event.target.value)} /></label>
          <CronField id="personal-data-checkpoint-cron" label={t({ en: "Checkpoint Cron", "zh-CN": "检查点 Cron" })} value={data.checkpointCron} onChange={(value) => updateDraft("checkpointCron", value)} defaultValue={DEFAULT_CHECKPOINT_CRON} />
          <CronField id="personal-data-push-cron" label={t({ en: "Push Cron", "zh-CN": "推送 Cron" })} value={data.pushCron} onChange={(value) => updateDraft("pushCron", value)} defaultValue={DEFAULT_PUSH_CRON} />
        </div>
        <p className="settings-muted">{t({ en: "Last success:", "zh-CN": "上次成功：" })} {data.lastSuccessAt ? formatDateTime(data.lastSuccessAt) : "—"} · {t({ en: "Next checkpoint:", "zh-CN": "下次检查点：" })} {data.nextRunAt ? formatDateTime(data.nextRunAt) : "—"}</p>
        {data.lastError && <p role="alert" className="settings-error">{t({ en: "Last error:", "zh-CN": "最近错误：" })} {data.lastError}</p>}
        <div className="settings-form-row">
          <button type="button" className="button-primary" onClick={() => save.mutate()} disabled={save.isPending || query.isPending}>{save.isPending ? t({ en: "Saving…", "zh-CN": "保存中…" }) : t({ en: "Save backup settings", "zh-CN": "保存备份设置" })}</button>
          <button type="button" onClick={() => checkpoint.mutate()} disabled={checkpoint.isPending || query.isPending}>{checkpoint.isPending ? t({ en: "Starting…", "zh-CN": "启动中…" }) : t({ en: "Checkpoint Now", "zh-CN": "立即创建检查点" })}</button>
          <button type="button" onClick={() => push.mutate()} disabled={push.isPending || query.isPending}>{push.isPending ? t({ en: "Pushing…", "zh-CN": "推送中…" }) : t({ en: "Push Now", "zh-CN": "立即推送" })}</button>
          <Link className="button-link" to="/settings/schedules">{t({ en: "Open schedules", "zh-CN": "打开计划任务" })}</Link>
        </div>
      </section>
    </div>
  );
}
