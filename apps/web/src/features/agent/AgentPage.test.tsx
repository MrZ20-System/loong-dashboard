import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentSessionResponse, AgentSessionSummary } from "@loongboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPage } from "./AgentPage";
import { listAgentSessions, updateAgentSession } from "../../agent-chat-client";

vi.mock("../../agent-chat", () => ({
  AgentChatPanel: () => <div data-testid="agent-chat-panel">Agent chat</div>,
}));

vi.mock("../../app/hooks", () => ({
  useRepositories: () => ({ data: { items: [] }, isPending: false }),
}));

vi.mock("../../agent-chat-client", () => ({
  deleteAgentSession: vi.fn(),
  ensureAgentSession: vi.fn(),
  listAgentSessions: vi.fn(),
  updateAgentSession: vi.fn(),
}));

const session: AgentSessionSummary = {
  id: "sess_title",
  scope: { kind: "pr", repositoryId: "repo", prNumber: 5, targetSha: "a".repeat(40) },
  workspacePath: "/tmp/worktree",
  dshHomePath: "/tmp/dsh-home",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  status: "idle",
  dshSessionId: null,
  title: "Native title",
  titleSource: "generated",
  createdAt: "2026-09-11T00:00:00.000Z",
  lastUsedAt: "2026-09-11T00:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/agent"]}>
      <QueryClientProvider client={client}>
        <AgentPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentPage titles", () => {
  it("displays generated titles, searches them, and submits an inline rename", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue({ items: [session] });
    const renamed: AgentSessionResponse = {
      session: { ...session, title: "Renamed title", titleSource: "manual" },
      targetRevision: session.scope.targetSha ?? null,
      workspaceRevision: session.scope.targetSha ?? null,
    };
    vi.mocked(updateAgentSession).mockResolvedValue(renamed);
    renderPage();

    expect(await screen.findByText("Native title")).toBeInTheDocument();
    const search = screen.getByLabelText("Search conversations");
    fireEvent.change(search, { target: { value: "native title" } });
    expect(screen.getByText("Native title")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename Native title" }));
    const titleInput = screen.getByLabelText("Conversation title");
    fireEvent.change(titleInput, { target: { value: "Renamed title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save conversation title" }));

    await waitFor(() => expect(updateAgentSession).toHaveBeenCalledWith("sess_title", { title: "Renamed title" }));
  });
});
