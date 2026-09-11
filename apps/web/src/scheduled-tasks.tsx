import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n, type LocalizedMessage, type MessageValues } from "./i18n";
import {
  createScheduledTask,
  deleteScheduledTask,
  fetchScheduledTaskRuns,
  fetchScheduledTasks,
  runScheduledTask,
  updateScheduledTask,
} from "./scheduled-client";

function systemTaskHref(action: string | null | undefined): string {
  if (action === "knowledge.checkpoint" || action === "knowledge.push") return "/settings/checkpoint";
  if (action === "repository.sync") return "/settings/repositories";
  return "/settings";
}

type Feedback = { message: LocalizedMessage; values?: MessageValues };

/**
 * Scheduled tasks page. One form per task lets the user
 * define the cron expression and prompt that is sent verbatim to a fresh
 * Agent Session on the task's workspace.
 */
export function ScheduledTasksPage() {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<Feedback | null>(null);
  const [error, setError] = useState<Feedback | null>(null);
  const [form, setForm] = useState({
    name: "",
    cronExpression: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
    workspacePath: "",
    prompt: "",
    kind: "agent" as "agent" | "system",
    action: "",
  });

  const tasks = useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: () => fetchScheduledTasks(),
    refetchInterval: 3_000,
  });

  const runQueries = useQueries({
    queries: (tasks.data?.items ?? []).map((task) => ({
      queryKey: ["scheduled-runs", task.id],
      queryFn: () => fetchScheduledTaskRuns(task.id),
      refetchInterval: 3_000,
    })),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["scheduled-runs"] });
  };

  const create = useMutation({
    mutationFn: () =>
      createScheduledTask({
        name: form.name.trim(),
        cronExpression: form.cronExpression.trim(),
        timezone: form.timezone.trim(),
        enabled: true,
        kind: form.kind,
        ...(form.kind === "agent" ? { workspacePath: form.workspacePath.trim(), prompt: form.prompt } : {}),
        ...(form.kind === "system" && form.action.trim() ? { action: form.action.trim() } : {}),
      }),
    onSuccess: (task) => {
      setForm((previous) => ({ ...previous, name: "", workspacePath: "", prompt: "" }));
      setExpandedId(task.id);
      setMessage({ message: { en: 'Task "{name}" created.', "zh-CN": '任务“{name}”已创建。' }, values: { name: task.name } });
      invalidate();
    },
    onError: (failure: Error) => setError({ message: { en: "Create task failed: {detail}", "zh-CN": "创建任务失败：{detail}" }, values: { detail: failure.message } }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateScheduledTask(id, { enabled }),
    onSuccess: () => {
      setMessage({ message: { en: "Task updated.", "zh-CN": "任务已更新。" } });
      invalidate();
    },
    onError: (failure: Error) => setError({ message: { en: "Update task failed: {detail}", "zh-CN": "更新任务失败：{detail}" }, values: { detail: failure.message } }),
  });

  const edit = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateScheduledTask>[1] }) => updateScheduledTask(id, patch),
    onSuccess: () => {
      setEditingTaskId(null);
      setMessage({ message: { en: "Task updated.", "zh-CN": "任务已更新。" } });
      invalidate();
    },
    onError: (failure: Error) => setError({ message: { en: "Update task failed: {detail}", "zh-CN": "更新任务失败：{detail}" }, values: { detail: failure.message } }),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => runScheduledTask(id),
    onSuccess: (accepted) => {
      setMessage({ message: { en: "Run started ({runId}).", "zh-CN": "运行已开始（{runId}）。" }, values: { runId: accepted.runId } });
      invalidate();
    },
    onError: (failure: Error) => setError({ message: { en: "Run task failed: {detail}", "zh-CN": "运行任务失败：{detail}" }, values: { detail: failure.message } }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteScheduledTask(id),
    onSuccess: () => {
      setExpandedId(null);
      setMessage({ message: { en: "Task deleted.", "zh-CN": "任务已删除。" } });
      invalidate();
    },
    onError: (failure: Error) => setError({ message: { en: "Delete task failed: {detail}", "zh-CN": "删除任务失败：{detail}" }, values: { detail: failure.message } }),
  });

  const runs = expandedId === null
    ? undefined
    : runQueries.find((_query, index) => tasks.data?.items[index]?.id === expandedId);

  const submit = () => {
    if (form.name.trim().length === 0 || form.cronExpression.trim().length === 0 || form.timezone.trim().length === 0) {
      setError({ message: { en: "Name, cron expression, and timezone are required.", "zh-CN": "名称、cron 表达式和时区为必填项。" } });
      return;
    }
    if (form.kind === "agent" && (form.prompt.trim().length === 0 || form.workspacePath.trim().length === 0)) {
      setError({ message: { en: "Agent tasks require a prompt and workspace path.", "zh-CN": "Agent 任务需要提示词和工作区路径。" } });
      return;
    }
    if (form.kind === "system" && form.action.trim().length === 0) {
      setError({ message: { en: "System tasks require an action.", "zh-CN": "系统任务需要操作。" } });
      return;
    }
    create.mutate();
  };

  return (
    <section className="scheduled-page" aria-labelledby="scheduled-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t({ en: "Automation", "zh-CN": "自动化" })}</p>
          <h2 id="scheduled-heading">{t({ en: "Schedules", "zh-CN": "计划任务" })}</h2>
          <p className="page-subtitle">{t({ en: "Agent conversations and system actions in one scheduler.", "zh-CN": "在一个调度器中管理 Agent 对话和系统操作。" })}</p>
        </div>
      </div>
      {error !== null && <p role="alert" className="agent-error">{t(error.message, error.values)}</p>}
      {message !== null && <p role="status" className="agent-note">{t(message.message, message.values)}</p>}

      <form
        className="scheduled-form"
        onSubmit={(event) => { event.preventDefault(); setError(null); submit(); }}
      >
        <h3>{t({ en: "New task", "zh-CN": "新任务" })}</h3>
        <label>{t({ en: "Name", "zh-CN": "名称" })}<input aria-label={t({ en: "Task name", "zh-CN": "任务名称" })} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>{t({ en: "Cron (5 fields, local time zone)", "zh-CN": "Cron（5 个字段，本地时区）" })}<input aria-label={t({ en: "Cron expression", "zh-CN": "Cron 表达式" })} value={form.cronExpression} onChange={(event) => setForm({ ...form, cronExpression: event.target.value })} /></label>
        <label>{t({ en: "Timezone", "zh-CN": "时区" })}<input aria-label={t({ en: "Timezone", "zh-CN": "时区" })} value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></label>
        <label>{t({ en: "Type", "zh-CN": "类型" })}<select aria-label={t({ en: "Schedule type", "zh-CN": "计划任务类型" })} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "agent" | "system" })}><option value="agent">{t({ en: "Agent conversation", "zh-CN": "Agent 对话" })}</option><option value="system">{t({ en: "System action", "zh-CN": "系统操作" })}</option></select></label>
        {form.kind === "agent" && <><label>{t({ en: "Workspace path", "zh-CN": "工作区路径" })}<input aria-label={t({ en: "Workspace path", "zh-CN": "工作区路径" })} value={form.workspacePath} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} placeholder="/path/to/repo-or-knowledge" /></label><label>{t({ en: "Prompt (sent verbatim)", "zh-CN": "提示词（原样发送）" })}<textarea aria-label={t({ en: "Prompt", "zh-CN": "提示词" })} rows={3} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label></>}
        {form.kind === "system" && <label>{t({ en: "System action", "zh-CN": "系统操作" })}<input aria-label={t({ en: "System action", "zh-CN": "系统操作" })} value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })} placeholder="repository.sync or knowledge.checkpoint" /></label>}
        <button type="submit" disabled={create.isPending}>{create.isPending ? t({ en: "Creating…", "zh-CN": "创建中…" }) : t({ en: "Create task", "zh-CN": "创建任务" })}</button>
      </form>

      {tasks.isPending && <p role="status">{t({ en: "Loading tasks…", "zh-CN": "正在加载任务…" })}</p>}
      {tasks.isError && <p role="alert">{t({ en: "Unable to load scheduled tasks:", "zh-CN": "无法加载计划任务：" })} {tasks.error.message}</p>}
      {tasks.data !== undefined && tasks.data.items.length === 0 && (
        <p role="status">{t({ en: "No scheduled tasks yet.", "zh-CN": "还没有计划任务。" })}</p>
      )}
      <div className="scheduled-tasks">
        {tasks.data?.items.map((task, taskIndex) => (
          <article key={task.id} className="scheduled-task">
            <header>
              <div>
                <h3>{task.name}</h3>
                <p className="scheduled-meta">
                  <span className={`status-pill status-pill--${task.enabled ? "ok" : "unknown"}`}>{task.enabled ? t({ en: "Enabled", "zh-CN": "已启用" }) : t({ en: "Disabled", "zh-CN": "已禁用" })}</span> · {task.kind === "system" ? `${t({ en: "System", "zh-CN": "系统" })} · ${task.action ?? "—"}` : t({ en: "Agent conversation", "zh-CN": "Agent 对话" })} · {task.cronExpression} · {task.timezone}
                </p>
                <p className="scheduled-meta">
                  {t({ en: "next:", "zh-CN": "下次：" })} {task.nextRunAt ? formatDateTime(task.nextRunAt) : "—"} · {t({ en: "last:", "zh-CN": "上次：" })} {task.lastRunAt ? formatDateTime(task.lastRunAt) : "—"} · {t({ en: "workspace:", "zh-CN": "工作区：" })} {task.workspacePath ?? "—"}
                </p>
                <p className="scheduled-meta">
                  {t({ en: "last result:", "zh-CN": "上次结果：" })} {runQueries[taskIndex]?.data?.items[0]?.status ?? (runQueries[taskIndex]?.isPending ? t({ en: "Loading", "zh-CN": "加载中" }) : t({ en: "No runs", "zh-CN": "没有运行记录" }))}
                </p>
              </div>
              {task.kind === "system" && <Link className="scheduled-conversation-link" to={systemTaskHref(task.action)}>{t({ en: "Open settings", "zh-CN": "打开设置" })}</Link>}
              <div className="scheduled-actions">
                <button type="button" onClick={() => toggle.mutate({ id: task.id, enabled: !task.enabled })} disabled={toggle.isPending}>
                  {task.enabled ? t({ en: "Disable", "zh-CN": "禁用" }) : t({ en: "Enable", "zh-CN": "启用" })}
                </button>
                <button type="button" onClick={() => runNow.mutate(task.id)} disabled={runNow.isPending}>{t({ en: "Run now", "zh-CN": "立即运行" })}</button>
                <button type="button" onClick={() => { setEditingTaskId((current) => current === task.id ? null : task.id); setExpandedId(task.id); }} aria-expanded={editingTaskId === task.id}>{t({ en: "Edit", "zh-CN": "编辑" })}</button>
                <button type="button" onClick={() => { if (window.confirm(t({ en: `Delete task "${task.name}"?`, "zh-CN": `删除任务“${task.name}”吗？` }))) remove.mutate(task.id); }} disabled={remove.isPending}>{t({ en: "Delete", "zh-CN": "删除" })}</button>
                <button type="button" aria-expanded={expandedId === task.id} onClick={() => { setExpandedId((current) => current === task.id ? null : task.id); }}>
                  {t({ en: "History", "zh-CN": "历史" })}
                </button>
              </div>
            </header>
            {expandedId === task.id && <div className="scheduled-runs">
              {editingTaskId === task.id && <form className="scheduled-edit-form" onSubmit={(event) => { event.preventDefault(); const formData = new FormData(event.currentTarget); const patch = { name: String(formData.get("name") ?? "").trim(), cronExpression: String(formData.get("cronExpression") ?? "").trim(), timezone: String(formData.get("timezone") ?? "").trim(), ...(task.kind === "agent" ? { prompt: String(formData.get("prompt") ?? ""), workspacePath: String(formData.get("workspacePath") ?? "").trim() } : { action: String(formData.get("action") ?? "").trim() }) } as Parameters<typeof updateScheduledTask>[1]; if (!patch.name || !patch.cronExpression || !patch.timezone || (task.kind === "agent" && (!(patch.prompt ?? "") || !(patch.workspacePath ?? ""))) || (task.kind === "system" && !(patch.action ?? ""))) { setError({ message: task.kind === "agent" ? { en: "Agent tasks require name, schedule, prompt, and workspace path.", "zh-CN": "Agent 任务需要名称、计划、提示词和工作区路径。" } : { en: "System tasks require name, schedule, and action.", "zh-CN": "系统任务需要名称、计划和操作。" } }); return; } setError(null); edit.mutate({ id: task.id, patch }); }}><label>{t({ en: "Name", "zh-CN": "名称" })}<input name="name" defaultValue={task.name} /></label><label>{t({ en: "Cron", "zh-CN": "Cron" })}<input name="cronExpression" defaultValue={task.cronExpression} /></label><label>{t({ en: "Timezone", "zh-CN": "时区" })}<input name="timezone" defaultValue={task.timezone} /></label>{task.kind === "agent" ? <><label>{t({ en: "Workspace path", "zh-CN": "工作区路径" })}<input name="workspacePath" defaultValue={task.workspacePath ?? ""} /></label><label>{t({ en: "Prompt", "zh-CN": "提示词" })}<textarea name="prompt" defaultValue={task.prompt ?? ""} rows={3} /></label></> : <label>{t({ en: "System action", "zh-CN": "系统操作" })}<input name="action" defaultValue={task.action ?? ""} /></label>}<div className="scheduled-actions"><button className="button-primary" type="submit" disabled={edit.isPending}>{edit.isPending ? t({ en: "Saving…", "zh-CN": "保存中…" }) : t({ en: "Save changes", "zh-CN": "保存更改" })}</button><button type="button" onClick={() => setEditingTaskId(null)}>{t({ en: "Cancel", "zh-CN": "取消" })}</button></div></form>}
              {runs?.isPending && <p role="status">{t({ en: "Loading runs…", "zh-CN": "正在加载运行记录…" })}</p>}
              {runs?.isError && <p role="alert">{t({ en: "Unable to load task runs:", "zh-CN": "无法加载任务运行记录：" })} {runs.error.message}</p>}
              {runs?.data?.items.length === 0 && <p role="status">{t({ en: "No runs yet.", "zh-CN": "还没有运行记录。" })}</p>}
              <ul>
                {runs?.data?.items.map((run) => (
                  <li key={run.id}>
                    <span className={`run-status run-${run.status}`}>{run.status}</span>
                    <span>{formatDateTime(run.scheduledFor)}</span>
                    <span>{run.startedAt ? formatDateTime(run.startedAt) : "—"} → {run.finishedAt ? formatDateTime(run.finishedAt) : "—"}</span>
                    {run.error !== null && <span className="agent-error">{t({ en: "Error:", "zh-CN": "错误：" })} {run.error}</span>}
                    {run.agentSessionId !== null && run.agentSessionId.length > 0 && <Link className="scheduled-conversation-link" to={`/agent?session=${encodeURIComponent(run.agentSessionId)}`}>{t({ en: "Open conversation", "zh-CN": "打开对话" })}</Link>}
                  </li>
                ))}
              </ul>
            </div>}
          </article>
        ))}
      </div>
    </section>
  );
}
