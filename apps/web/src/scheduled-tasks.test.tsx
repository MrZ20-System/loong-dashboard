import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduledRun, ScheduledTask } from "@loongboard/contracts";

import { ScheduledTasksPage } from "./scheduled-tasks";
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
});

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
});
