import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const settingsMocks = vi.hoisted(() => ({
  fetchKnowledgeCheckpointSettings: vi.fn(),
  updateKnowledgeCheckpointSettings: vi.fn(),
  runKnowledgeCheckpoint: vi.fn(),
  pushKnowledgeCheckpoint: vi.fn(),
}));

vi.mock("../../settings-client", () => settingsMocks);

import { KnowledgeCheckpointSettingsPage } from "./SettingsControlCenter";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <KnowledgeCheckpointSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Knowledge checkpoint settings", () => {
  it("renders and saves the canonical checkpoint fields", async () => {
    settingsMocks.fetchKnowledgeCheckpointSettings.mockResolvedValue({
      autoCommit: true,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "loongboard-knowledge-backup",
      checkpointIntervalMinutes: 60,
      pushIntervalMinutes: null,
    });
    settingsMocks.updateKnowledgeCheckpointSettings.mockResolvedValue({});

    renderPage();

    expect(await screen.findByDisplayValue("main")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source ref"), {
      target: { value: "release" },
    });
    fireEvent.change(screen.getByLabelText("Checkpoint frequency"), {
      target: { value: "240" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));

    await waitFor(() => expect(settingsMocks.updateKnowledgeCheckpointSettings).toHaveBeenCalledWith({
      sourceRef: "release",
      checkpointIntervalMinutes: 240,
    }));
    const payload = settingsMocks.updateKnowledgeCheckpointSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("branch");
    expect(payload).not.toHaveProperty("intervalMinutes");
  });
});
