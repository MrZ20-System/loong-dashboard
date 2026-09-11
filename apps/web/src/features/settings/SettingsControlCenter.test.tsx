import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const settingsMocks = vi.hoisted(() => ({
  fetchKnowledgeCheckpointSettings: vi.fn(),
  updateKnowledgeCheckpointSettings: vi.fn(),
  runKnowledgeCheckpoint: vi.fn(),
  pushKnowledgeCheckpoint: vi.fn(),
  fetchCodeBackupSettings: vi.fn(),
  updateCodeBackupSettings: vi.fn(),
  runCodeBackupCheckpoint: vi.fn(),
  pushCodeBackup: vi.fn(),
  fetchAgentArchiveSettings: vi.fn(),
  updateAgentArchiveSettings: vi.fn(),
  runAgentArchiveExport: vi.fn(),
  pushAgentArchive: vi.fn(),
}));

vi.mock("../../settings-client", () => settingsMocks);

import { CodeBackupSettingsPage, KnowledgeCheckpointSettingsPage } from "./SettingsControlCenter";

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

function renderCodeBackupPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CodeBackupSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function codeBackupCard() {
  const heading = screen.getByRole("heading", { name: "Code backup" });
  const card = heading.closest("section");
  if (card === null) throw new Error("Code backup card was not rendered");
  return within(card);
}

function codeBackupSettings(available: boolean) {
  return {
    available,
    repositoryPath: "/workspace/loong-dashboard",
    automaticCheckpoint: true,
    checkpointIntervalMinutes: 60,
    automaticPush: true,
    pushIntervalMinutes: 1440,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-backup",
    lastCheckpointAt: null,
    nextCheckpointAt: null,
    lastPushAt: null,
    nextPushAt: null,
    lastError: null,
  };
}

function mockAgentArchiveSettings() {
  settingsMocks.fetchAgentArchiveSettings.mockResolvedValue({
    archiveRepositoryPath: "/workspace/agent-history",
    enabled: false,
    exportIntervalMinutes: null,
    automaticPush: false,
    pushIntervalMinutes: null,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "agent-history-backup",
    lastExportAt: null,
    nextExportAt: null,
    lastPushAt: null,
    lastError: null,
  });
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

describe("Code backup settings", () => {
  it("shows the container-image limitation and blocks code backup actions when unavailable", async () => {
    settingsMocks.fetchCodeBackupSettings.mockResolvedValue(codeBackupSettings(false));
    mockAgentArchiveSettings();

    renderCodeBackupPage();

    await screen.findByDisplayValue("/workspace/loong-dashboard");
    const card = codeBackupCard();
    expect(await screen.findByText("Code backup unavailable in container-image deployment.")).toBeInTheDocument();
    expect(card.getByRole("switch", { name: /^Automatic checkpoint/ })).toBeDisabled();
    expect(card.getByRole("switch", { name: /^Automatic push/ })).toBeDisabled();
    expect(card.getByRole("button", { name: "Checkpoint now" })).toBeDisabled();
    expect(card.getByRole("button", { name: "Push now" })).toBeDisabled();

    fireEvent.click(card.getByRole("switch", { name: /^Automatic checkpoint/ }));
    fireEvent.click(card.getByRole("button", { name: "Checkpoint now" }));
    fireEvent.click(card.getByRole("button", { name: "Push now" }));

    expect(settingsMocks.runCodeBackupCheckpoint).not.toHaveBeenCalled();
    expect(settingsMocks.pushCodeBackup).not.toHaveBeenCalled();
    expect(settingsMocks.updateCodeBackupSettings).not.toHaveBeenCalled();
  });

  it("keeps code backup controls available when the runtime reports availability", async () => {
    settingsMocks.fetchCodeBackupSettings.mockResolvedValue(codeBackupSettings(true));
    settingsMocks.runCodeBackupCheckpoint.mockResolvedValue({ accepted: true });
    settingsMocks.pushCodeBackup.mockResolvedValue({ accepted: true });
    mockAgentArchiveSettings();

    renderCodeBackupPage();

    await screen.findByDisplayValue("/workspace/loong-dashboard");
    const card = codeBackupCard();
    expect(screen.queryByText("Code backup unavailable in container-image deployment.")).not.toBeInTheDocument();
    expect(card.getByRole("switch", { name: /^Automatic checkpoint/ })).not.toBeDisabled();
    expect(card.getByRole("switch", { name: /^Automatic push/ })).not.toBeDisabled();
    expect(card.getByRole("button", { name: "Checkpoint now" })).not.toBeDisabled();
    expect(card.getByRole("button", { name: "Push now" })).not.toBeDisabled();

    fireEvent.click(card.getByRole("button", { name: "Checkpoint now" }));
    fireEvent.click(card.getByRole("button", { name: "Push now" }));

    await waitFor(() => {
      expect(settingsMocks.runCodeBackupCheckpoint).toHaveBeenCalledTimes(1);
      expect(settingsMocks.pushCodeBackup).toHaveBeenCalledTimes(1);
    });
  });
});
