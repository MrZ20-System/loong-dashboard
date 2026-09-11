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
import { fetchAgentRuntimeSettings } from "./settings-client";

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

vi.mock("./settings-client", () => ({
  fetchAgentRuntimeSettings: vi.fn(),
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
      title: null,
      titleSource: "provisional",
      createdAt: "2026-09-03T00:00:00.000Z",
      lastUsedAt: "2026-09-03T00:00:00.000Z",
    },
    targetRevision: targetSha,
    workspaceRevision,
  };
}

function renderPanel(agentView: AgentSessionResponse, commands: Array<{ id: string; label?: string; description?: string }> = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(ensureAgentSession).mockResolvedValue(agentView);
  vi.mocked(fetchAgentSession).mockResolvedValue(agentView);
  vi.mocked(fetchAgentMessages).mockResolvedValue({ items: [] });
  vi.mocked(listAgentSessions).mockResolvedValue({ items: [] });
  vi.mocked(fetchAgentRuntimeSettings).mockResolvedValue({
    status: "connected",
    version: "test",
    profile: "test",
    connected: true,
    defaultProvider: "test-provider",
    defaultModel: "test-model",
    defaultReasoning: "high",
    retentionMinutes: 0,
    capabilities: {
      runtimeKind: "test-runtime",
      version: "test",
      profile: "test",
      connected: true,
      models: [],
      reasoning: [],
      commands,
      features: [],
      discovery: "runtime",
    },
  });
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
    const panel = await screen.findByRole("complementary", { name: "PR chat" });
    expect(panel.querySelector(".agent-messages")).toHaveClass("agent-messages");
    expect(panel.querySelector(".agent-composer")).toHaveClass("agent-composer");
    const composerActions = panel.querySelector(".agent-composer-actions");
    expect(composerActions).toHaveClass("agent-composer-actions");
    expect(composerActions?.querySelectorAll(".agent-composer-select")).toHaveLength(2);
    expect(composerActions?.querySelector(".agent-composer-hint")).toBeInTheDocument();
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

describe("AgentChatPanel runtime command composer", () => {
  it("filters runtime commands by id or label and inserts the selected id", async () => {
    renderPanel(view(targetSha), [
      { id: "review", label: "Review PR", description: "Inspect the change" },
      { id: "refactor", label: "Refactor" },
    ]);

    const input = await screen.findByLabelText("Message the agent");
    fireEvent.change(input, { target: { value: "/rev" } });
    const menu = await screen.findByRole("listbox", { name: "Runtime commands" });
    expect(input.parentElement).toHaveClass("agent-composer__input");
    expect(menu).toHaveClass("agent-command-menu");
    expect(menu.parentElement).toBe(input.parentElement);
    expect(await screen.findByRole("option", { name: /review.*Review PR/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /refactor/i })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/review ");

    fireEvent.change(input, { target: { value: "/r" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/refactor ");

    fireEvent.change(input, { target: { value: "/rev" } });
    fireEvent.click(await screen.findByRole("option", { name: /review.*Review PR/i }));
    expect(input).toHaveValue("/review ");

    fireEvent.change(input, { target: { value: "/r" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Runtime commands" })).not.toBeInTheDocument();
  });

  it("shows a clear empty state when the runtime has no commands", async () => {
    renderPanel(view(targetSha));
    fireEvent.change(await screen.findByLabelText("Message the agent"), { target: { value: "/" } });
    expect(await screen.findByText("No runtime commands available.")).toBeInTheDocument();
  });
});
