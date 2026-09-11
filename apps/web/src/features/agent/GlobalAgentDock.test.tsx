import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GlobalAgentDock } from "./GlobalAgentDock";
import { AgentSessionSelectionProvider } from "./agent-session-context";

vi.mock("../../agent-chat", () => ({
  AgentChatPanel: () => <div data-testid="agent-chat-panel">Agent chat</div>,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function renderDock() {
  return render(
    <MemoryRouter initialEntries={["/repositories/example/activity"]}>
      <AgentSessionSelectionProvider>
        <GlobalAgentDock />
      </AgentSessionSelectionProvider>
    </MemoryRouter>,
  );
}

describe("GlobalAgentDock", () => {
  it("keeps the launcher and expanded panel mutually exclusive", () => {
    renderDock();

    const launcher = screen.getByRole("button", { name: "Open Agent dock" });
    expect(screen.queryByTestId("agent-chat-panel")).not.toBeInTheDocument();
    fireEvent.click(launcher);

    expect(screen.getByTestId("agent-chat-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Agent dock" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Agent dock" }));

    expect(screen.getByRole("button", { name: "Open Agent dock" })).toBeInTheDocument();
    expect(screen.queryByTestId("agent-chat-panel")).not.toBeInTheDocument();
  });
});
