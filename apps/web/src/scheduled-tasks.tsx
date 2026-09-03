import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createScheduledTask,
  deleteScheduledTask,
  fetchScheduledTaskRuns,
  fetchScheduledTasks,
  runScheduledTask,
  updateScheduledTask,
} from "./scheduled-client";

/**
 * Scheduled tasks page (plan 16, 17.7, 18). One form per task lets the user
 * define the cron expression and prompt that is sent verbatim to a fresh
 * Agent Session on the task's workspace.
 */
export function ScheduledTasksPage() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    cronExpression: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
    workspacePath: "",
    prompt: "",
  });

  const tasks = useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: () => fetchScheduledTasks(),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    if (expandedId !== null) {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-runs", expandedId] });
    }
  };

  const create = useMutation({
    mutationFn: () =>
      createScheduledTask({
        name: form.name.trim(),
        cronExpression: form.cronExpression.trim(),
        timezone: form.timezone.trim(),
        workspacePath: form.workspacePath.trim(),
        prompt: form.prompt,
        enabled: true,
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

  const runs = useQuery({
    queryKey: ["scheduled-runs", expandedId],
    enabled: expandedId !== null,
    queryFn: () => fetchScheduledTaskRuns(expandedId as string),
    refetchInterval: 5_000,
  });

  const submit = () => {
    if (form.name.trim().length === 0 || form.prompt.trim().length === 0 || form.workspacePath.trim().length === 0) {
      setError("Name, prompt, and workspace path are required.");
      return;
    }
    create.mutate();
  };

  return (
    <section className="scheduled-page" aria-labelledby="scheduled-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Automation</p>
          <h2 id="scheduled-heading">Scheduled agent tasks</h2>
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
        <label>Workspace path<input aria-label="Workspace path" value={form.workspacePath} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} placeholder="/path/to/repo-or-knowledge" /></label>
        <label>Prompt (sent verbatim)<textarea aria-label="Prompt" rows={3} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
        <button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create task"}</button>
      </form>

      {tasks.isPending && <p role="status">Loading tasks…</p>}
      {tasks.isError && <p role="alert">{tasks.error.message}</p>}
      {tasks.data !== undefined && tasks.data.items.length === 0 && (
        <p role="status">No scheduled tasks yet.</p>
      )}
      <div className="scheduled-tasks">
        {tasks.data?.items.map((task) => (
          <article key={task.id} className="scheduled-task">
            <header>
              <div>
                <h3>{task.name}</h3>
                <p className="scheduled-meta">
                  {task.cronExpression} · {task.timezone} · {task.enabled ? "enabled" : "disabled"}
                </p>
                <p className="scheduled-meta">
                  next: {task.nextRunAt ?? "—"} · last: {task.lastRunAt ?? "—"} · workspace: {task.workspacePath}
                </p>
              </div>
              <div className="scheduled-actions">
                <button type="button" onClick={() => toggle.mutate({ id: task.id, enabled: !task.enabled })} disabled={toggle.isPending}>
                  {task.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => runNow.mutate(task.id)} disabled={runNow.isPending}>Run now</button>
                <button type="button" onClick={() => { if (window.confirm(`Delete task "${task.name}"?`)) remove.mutate(task.id); }} disabled={remove.isPending}>Delete</button>
                <button type="button" aria-expanded={expandedId === task.id} onClick={() => { setExpandedId((current) => current === task.id ? null : task.id); }}>
                  History
                </button>
              </div>
            </header>
            <details open={expandedId === task.id}>
              <summary className="sr-only">Run history</summary>
              {expandedId === task.id && (
                <div className="scheduled-runs">
                  {runs.isPending && <p role="status">Loading runs…</p>}
                  {runs.isError && <p role="alert">{runs.error.message}</p>}
                  {runs.data?.items.length === 0 && <p role="status">No runs yet.</p>}
                  <ul>
                    {runs.data?.items.map((run) => (
                      <li key={run.id}>
                        <span className={`run-status run-${run.status}`}>{run.status}</span>
                        <span>{run.scheduledFor}</span>
                        <span>{run.startedAt ?? "—"} → {run.finishedAt ?? "—"}</span>
                        {run.error !== null && <span className="agent-error">{run.error}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
