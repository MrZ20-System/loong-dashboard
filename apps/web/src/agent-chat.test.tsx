import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentScope, AgentSessionResponse } from "@loongboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChatPanel } from "./agent-chat";
import {
  ensureAgentSession,
  fetchAgentMessages,
  fetchAgentSession,
  listAgentSessions,
  sendAgentMessage,
} from "./agent-chat-client";

vi.mock("./agent-chat-client", () => ({
  cancelAgentTurn: vi.fn(),
  connectAgentEvents: vi.fn(() => () => undefined),
  ensureAgentSession: vi.fn(),
  fetchAgentMessages: vi.fn(),
  fetchAgentSession: vi.fn(),
  listAgentSessions: vi.fn(),
  sendAgentMessage: vi.fn(),
  syncAgentWorkspace: vi.fn(),
}));

const targetSha = "b".repeat(40);
const actualSha = "a".repeat(40);

const prScope: AgentScope = {
  kind: "pr",
  repositoryId: "repo",
  prNumber: 5,
  targetSha,
};

function view(workspaceRevision: string | null): AgentSessionResponse {
  return {
    session: {
      id: "sess_1",
      scope: prScope,
      workspacePath: "/tmp/pr-worktree",
      dshHomePath: "/tmp/dsh-home",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      status: "idle",
      dshSessionId: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      lastUsedAt: "2026-09-03T00:00:00.000Z",
    },
    targetRevision: targetSha,
    workspaceRevision,
  };
}

function renderPanel(agentView: AgentSessionResponse) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(ensureAgentSession).mockResolvedValue(agentView);
  vi.mocked(fetchAgentSession).mockResolvedValue(agentView);
  vi.mocked(fetchAgentMessages).mockResolvedValue({ items: [] });
  vi.mocked(listAgentSessions).mockResolvedValue({ items: [] });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentChatPanel scope={prScope} heading="PR chat" />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentChatPanel PR revision gating", () => {
  it("treats a null workspace revision as a mismatch and disables Send", async () => {
    renderPanel(view(null));

    expect(
      await screen.findByText(
        /Workspace does not match this PR revision\. Sync the workspace before continuing this chat\./,
      ),
    ).toBeInTheDocument();
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.change(screen.getByLabelText("Message the agent"), {
      target: { value: "continue on this PR" },
    });
    expect(send).toBeDisabled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Sync workspace" }),
    ).not.toBeDisabled();
  });

  it("disables Send when the workspace revision differs from the target", async () => {
    renderPanel(view(actualSha));

    await screen.findByText(
      /Workspace does not match this PR revision\. Sync the workspace before continuing this chat\./,
    );
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.change(screen.getByLabelText("Message the agent"), {
      target: { value: "wrong revision" },
    });
    expect(send).toBeDisabled();
  });

  it("enables Send when the workspace revision equals the target", async () => {
    renderPanel(view(targetSha));
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.change(screen.getByLabelText("Message the agent"), {
      target: { value: "right revision" },
    });
    await waitFor(() => expect(send).not.toBeDisabled());

    fireEvent.click(send);
    await waitFor(() =>
      expect(sendAgentMessage).toHaveBeenCalledWith("sess_1", "right revision"),
    );
    expect(
      screen.queryByText(/Workspace does not match this PR revision/),
    ).not.toBeInTheDocument();
  });
});
