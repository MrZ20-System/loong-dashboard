import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduledRun, ScheduledTask } from "@loongboard/contracts";

import { ScheduledTasksPage } from "./scheduled-tasks";
import { LocaleProvider, useI18n } from "./i18n";
import {
  createScheduledTask,
  deleteScheduledTask,
  fetchScheduledTaskRuns,
  fetchScheduledTasks,
  runScheduledTask,
  updateScheduledTask,
} from "./scheduled-client";

vi.mock("./scheduled-client", () => ({
  createScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  fetchScheduledTaskRuns: vi.fn(),
  fetchScheduledTasks: vi.fn(),
  runScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
}));

const task: ScheduledTask = {
  id: "task-1",
  name: "Daily report",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  prompt: "Summarize the repository.",
  workspacePath: "/workspace/repo",
  provider: "provider",
  model: "model",
  reasoningEffort: "high",
  kind: "agent",
  action: null,
  repositoryId: null,
  enabled: true,
  lastRunAt: "2026-09-11T09:00:00.000Z",
  nextRunAt: "2026-09-12T09:00:00.000Z",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-11T09:00:00.000Z",
};

const runs: ScheduledRun[] = [
  {
    id: "run-2",
    taskId: task.id,
    scheduledFor: "2026-09-11T09:00:00.000Z",
    startedAt: "2026-09-11T09:00:01.000Z",
    finishedAt: "2026-09-11T09:01:00.000Z",
    status: "completed",
    agentSessionId: "session-2",
    error: null,
  },
  {
    id: "run-1",
    taskId: task.id,
    scheduledFor: "2026-09-10T09:00:00.000Z",
    startedAt: "2026-09-10T09:00:01.000Z",
    finishedAt: "2026-09-10T09:01:00.000Z",
    status: "failed",
    agentSessionId: "session-1",
    error: "failed",
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.lang = "en";
  try {
    window.localStorage?.removeItem("loongboard.locale");
  } catch {
    // Storage can be unavailable in the test environment.
  }
});

function ForceChineseLocale() {
  const { setLocale } = useI18n();
  useEffect(() => setLocale("zh-CN"), [setLocale]);
  return null;
}

function LocaleControls() {
  const { setLocale } = useI18n();
  return (
    <div>
      <button type="button" onClick={() => setLocale("zh-CN")}>Chinese test locale</button>
      <button type="button" onClick={() => setLocale("en")}>English test locale</button>
    </div>
  );
}

describe("ScheduledTasksPage history", () => {
  it("links every historical run to its own Agent session", async () => {
    vi.mocked(fetchScheduledTasks).mockResolvedValue({ items: [task] });
    vi.mocked(fetchScheduledTaskRuns).mockResolvedValue({ items: runs });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ScheduledTasksPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const links = await screen.findAllByRole("link", { name: "Open conversation" });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/agent?session=session-2",
      "/agent?session=session-1",
    ]);
    expect(createScheduledTask).not.toHaveBeenCalled();
    expect(deleteScheduledTask).not.toHaveBeenCalled();
    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });

  it("localizes schedule chrome while preserving task data and formatted dates", async () => {
    vi.mocked(fetchScheduledTasks).mockResolvedValue({ items: [task] });
    vi.mocked(fetchScheduledTaskRuns).mockResolvedValue({ items: runs });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <LocaleProvider>
        <ForceChineseLocale />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ScheduledTasksPage />
          </MemoryRouter>
        </QueryClientProvider>
      </LocaleProvider>,
    );

    expect(await screen.findByRole("heading", { name: "计划任务" })).toBeInTheDocument();
    expect(await screen.findByText("Daily report")).toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
    expect(screen.queryByText("2026-09-12T09:00:00.000Z")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/错误： failed/)).toBeInTheDocument();
  });

  it("adds a localized prefix to schedule query errors and preserves the detail", async () => {
    vi.mocked(fetchScheduledTasks).mockRejectedValue(new Error("raw scheduler detail"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <LocaleProvider>
        <ForceChineseLocale />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ScheduledTasksPage />
          </MemoryRouter>
        </QueryClientProvider>
      </LocaleProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载计划任务： raw scheduler detail");
  });

  it("re-renders a successful mutation feedback after locale changes without rerunning it", async () => {
    vi.mocked(fetchScheduledTasks).mockResolvedValue({ items: [] });
    vi.mocked(createScheduledTask).mockResolvedValue({ ...task, name: "New task" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <LocaleProvider>
        <ForceChineseLocale />
        <LocaleControls />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><ScheduledTasksPage /></MemoryRouter>
        </QueryClientProvider>
      </LocaleProvider>,
    );

    fireEvent.change(await screen.findByLabelText("任务名称"), { target: { value: "New task" } });
    fireEvent.change(screen.getByLabelText("工作区路径"), { target: { value: "/workspace/repo" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "Run report" } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));

    expect(await screen.findByText("任务“New task”已创建。", { exact: true })).toBeInTheDocument();
    expect(createScheduledTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "English test locale" }));
    expect(screen.getByText('Task "New task" created.', { exact: true })).toBeInTheDocument();
    expect(createScheduledTask).toHaveBeenCalledTimes(1);
  });

  it("re-renders a failed mutation prefix after locale changes while preserving raw detail", async () => {
    vi.mocked(fetchScheduledTasks).mockResolvedValue({ items: [] });
    vi.mocked(createScheduledTask).mockRejectedValue(new Error("raw create detail"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <LocaleProvider>
        <ForceChineseLocale />
        <LocaleControls />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><ScheduledTasksPage /></MemoryRouter>
        </QueryClientProvider>
      </LocaleProvider>,
    );

    fireEvent.change(await screen.findByLabelText("任务名称"), { target: { value: "New task" } });
    fireEvent.change(screen.getByLabelText("工作区路径"), { target: { value: "/workspace/repo" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "Run report" } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("创建任务失败：raw create detail");
    expect(createScheduledTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "English test locale" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Create task failed: raw create detail"));
    expect(createScheduledTask).toHaveBeenCalledTimes(1);
  });
});
