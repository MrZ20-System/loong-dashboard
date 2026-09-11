import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositorySummary } from "../metadata-client";
import { useRepositories } from "../app/hooks";
import { ContextHeader } from "./ContextHeader";

vi.mock("../app/hooks", () => ({
  useRepositories: vi.fn(),
}));

vi.mock("../components/repository/RepositorySyncStatus", () => ({
  RepositorySyncStatus: ({ repositoryId }: { repositoryId: string }) => (
    <span data-testid="sync-child" data-repository-id={repositoryId}>
      Sync now
    </span>
  ),
}));

const repository: RepositorySummary = {
  id: "repo",
  key: "repo",
  displayName: "LoongBoard",
  githubOwner: "acme",
  githubName: "project",
  localPath: "/tmp/project",
  remoteName: "origin",
  defaultBranch: "main",
  worktreeSlots: 1,
  enabled: true,
  mergedPullRequestCount: 0,
};

function renderHeader(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ContextHeader
        sidebarOpen={false}
        onMenuClick={() => undefined}
        theme="light"
        onThemeChange={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe("ContextHeader", () => {
  beforeEach(() => {
    vi.mocked(useRepositories).mockReturnValue({
      data: { items: [repository] },
      isPending: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useRepositories>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders repository context and passes the repo id to sync status", () => {
    renderHeader("/repositories/repo/pulls");

    expect(screen.getByText("acme/project")).toBeInTheDocument();
    expect(screen.getByText("LoongBoard · Pull requests")).toBeInTheDocument();
    expect(screen.getByTestId("sync-child")).toHaveAttribute(
      "data-repository-id",
      "repo",
    );
    expect(screen.getByText("Sync now")).toBeInTheDocument();
  });

  it("does not render repository sync status on global routes", () => {
    renderHeader("/settings");

    expect(screen.getByRole("banner")).toHaveTextContent("Settings");
    expect(screen.queryByTestId("sync-child")).not.toBeInTheDocument();
  });
});
