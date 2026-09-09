import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
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

/**
 * Scheduled tasks page (plan 16, 17.7, 18). One form per task lets the user
 * define the cron expression and prompt that is sent verbatim to a fresh
 * Agent Session on the task's workspace.
 */
export function ScheduledTasksPage() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setMessage(`Task "${task.name}" created.`);
      invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateScheduledTask(id, { enabled }),
    onSuccess: () => {
      setMessage("Task updated.");
      invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const edit = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateScheduledTask>[1] }) => updateScheduledTask(id, patch),
    onSuccess: () => {
      setEditingTaskId(null);
      setMessage("Task updated.");
      invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => runScheduledTask(id),
    onSuccess: (accepted) => {
      setMessage(`Run started (${accepted.runId}).`);
      invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteScheduledTask(id),
    onSuccess: () => {
      setExpandedId(null);
      setMessage("Task deleted.");
      invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const runs = expandedId === null
    ? undefined
    : runQueries.find((_query, index) => tasks.data?.items[index]?.id === expandedId);

  const submit = () => {
    if (form.name.trim().length === 0 || form.cronExpression.trim().length === 0 || form.timezone.trim().length === 0) {
      setError("Name, cron expression, and timezone are required.");
      return;
    }
    if (form.kind === "agent" && (form.prompt.trim().length === 0 || form.workspacePath.trim().length === 0)) {
      setError("Agent tasks require a prompt and workspace path.");
      return;
    }
    if (form.kind === "system" && form.action.trim().length === 0) {
      setError("System tasks require an action.");
      return;
    }
    create.mutate();
  };

  return (
    <section className="scheduled-page" aria-labelledby="scheduled-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Automation</p>
          <h2 id="scheduled-heading">Schedules</h2>
          <p className="page-subtitle">Agent conversations and system actions in one scheduler.</p>
        </div>
      </div>
      {error !== null && <p role="alert" className="agent-error">{error}</p>}
      {message !== null && <p role="status" className="agent-note">{message}</p>}

      <form
        className="scheduled-form"
        onSubmit={(event) => { event.preventDefault(); setError(null); submit(); }}
      >
        <h3>New task</h3>
        <label>Name<input aria-label="Task name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Cron (5 fields, local time zone)<input aria-label="Cron expression" value={form.cronExpression} onChange={(event) => setForm({ ...form, cronExpression: event.target.value })} /></label>
        <label>Timezone<input aria-label="Timezone" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></label>
        <label>Type<select aria-label="Schedule type" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "agent" | "system" })}><option value="agent">Agent conversation</option><option value="system">System action</option></select></label>
        {form.kind === "agent" && <><label>Workspace path<input aria-label="Workspace path" value={form.workspacePath} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} placeholder="/path/to/repo-or-knowledge" /></label><label>Prompt (sent verbatim)<textarea aria-label="Prompt" rows={3} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label></>}
        {form.kind === "system" && <label>System action<input aria-label="System action" value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })} placeholder="repository.sync or knowledge.checkpoint" /></label>}
        <button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create task"}</button>
      </form>

      {tasks.isPending && <p role="status">Loading tasks…</p>}
      {tasks.isError && <p role="alert">{tasks.error.message}</p>}
      {tasks.data !== undefined && tasks.data.items.length === 0 && (
        <p role="status">No scheduled tasks yet.</p>
      )}
      <div className="scheduled-tasks">
        {tasks.data?.items.map((task, taskIndex) => (
          <article key={task.id} className="scheduled-task">
            <header>
              <div>
                <h3>{task.name}</h3>
                <p className="scheduled-meta">
                  <span className={`status-pill status-pill--${task.enabled ? "ok" : "unknown"}`}>{task.enabled ? "Enabled" : "Disabled"}</span> · {task.kind === "system" ? `System · ${task.action ?? "action"}` : "Agent conversation"} · {task.cronExpression} · {task.timezone}
                </p>
                <p className="scheduled-meta">
                  next: {task.nextRunAt ?? "—"} · last: {task.lastRunAt ?? "—"} · workspace: {task.workspacePath}
                </p>
                <p className="scheduled-meta">
                  last result: {runQueries[taskIndex]?.data?.items[0]?.status ?? (runQueries[taskIndex]?.isPending ? "Loading" : "No runs")}
                </p>
              </div>
              {task.kind === "system" ? <Link className="scheduled-conversation-link" to={systemTaskHref(task.action)}>Open settings</Link> : task.conversationId && <Link className="scheduled-conversation-link" to={`/agent?session=${encodeURIComponent(task.conversationId)}`}>Open conversation</Link>}
              <div className="scheduled-actions">
                <button type="button" onClick={() => toggle.mutate({ id: task.id, enabled: !task.enabled })} disabled={toggle.isPending}>
                  {task.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => runNow.mutate(task.id)} disabled={runNow.isPending}>Run now</button>
                <button type="button" onClick={() => { setEditingTaskId((current) => current === task.id ? null : task.id); setExpandedId(task.id); }} aria-expanded={editingTaskId === task.id}>Edit</button>
                <button type="button" onClick={() => { if (window.confirm(`Delete task "${task.name}"?`)) remove.mutate(task.id); }} disabled={remove.isPending}>Delete</button>
                <button type="button" aria-expanded={expandedId === task.id} onClick={() => { setExpandedId((current) => current === task.id ? null : task.id); }}>
                  History
                </button>
              </div>
            </header>
            {expandedId === task.id && <div className="scheduled-runs">
              {editingTaskId === task.id && <form className="scheduled-edit-form" onSubmit={(event) => { event.preventDefault(); const formData = new FormData(event.currentTarget); const patch = { name: String(formData.get("name") ?? "").trim(), cronExpression: String(formData.get("cronExpression") ?? "").trim(), timezone: String(formData.get("timezone") ?? "").trim(), ...(task.kind === "agent" ? { prompt: String(formData.get("prompt") ?? ""), workspacePath: String(formData.get("workspacePath") ?? "").trim() } : { action: String(formData.get("action") ?? "").trim() }) } as Parameters<typeof updateScheduledTask>[1]; if (!patch.name || !patch.cronExpression || !patch.timezone || (task.kind === "agent" && (!(patch.prompt ?? "") || !(patch.workspacePath ?? ""))) || (task.kind === "system" && !(patch.action ?? ""))) { setError(task.kind === "agent" ? "Agent tasks require name, schedule, prompt, and workspace path." : "System tasks require name, schedule, and action."); return; } setError(null); edit.mutate({ id: task.id, patch }); }}><label>Name<input name="name" defaultValue={task.name} /></label><label>Cron<input name="cronExpression" defaultValue={task.cronExpression} /></label><label>Timezone<input name="timezone" defaultValue={task.timezone} /></label>{task.kind === "agent" ? <><label>Workspace path<input name="workspacePath" defaultValue={task.workspacePath} /></label><label>Prompt<textarea name="prompt" defaultValue={task.prompt} rows={3} /></label></> : <label>System action<input name="action" defaultValue={task.action ?? ""} /></label>}<div className="scheduled-actions"><button className="button-primary" type="submit" disabled={edit.isPending}>{edit.isPending ? "Saving…" : "Save changes"}</button><button type="button" onClick={() => setEditingTaskId(null)}>Cancel</button></div></form>}
              {runs?.isPending && <p role="status">Loading runs…</p>}
              {runs?.isError && <p role="alert">{runs.error.message}</p>}
              {runs?.data?.items.length === 0 && <p role="status">No runs yet.</p>}
              <ul>
                {runs?.data?.items.map((run) => (
                  <li key={run.id}>
                    <span className={`run-status run-${run.status}`}>{run.status}</span>
                    <span>{run.scheduledFor}</span>
                    <span>{run.startedAt ?? "—"} → {run.finishedAt ?? "—"}</span>
                    {run.error !== null && <span className="agent-error">{run.error}</span>}
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
