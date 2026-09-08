import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositories } from "../app/hooks";
import type { RepositorySummary } from "../metadata-client";
import { AppSidebar } from "./AppSidebar";

vi.mock("../app/hooks", () => ({
  useRepositories: vi.fn(),
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
};

function NavigationControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/knowledge")}>
        Navigate away
      </button>
      <button type="button" onClick={() => navigate("/repositories/repo/pulls")}>
        Navigate back
      </button>
    </>
  );
}

function renderSidebar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppSidebar open onClose={() => undefined} />
      <NavigationControls />
    </MemoryRouter>,
  );
}

function renderCompactSidebar(path: string) {
  const onToggleCompact = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AppSidebar
        open
        onClose={() => undefined}
        compact
        onToggleCompact={onToggleCompact}
      />
    </MemoryRouter>,
  );
  return { onToggleCompact, ...view };
}

describe("AppSidebar", () => {
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

  it("keeps a manually collapsed repository closed across navigation", () => {
    renderSidebar("/repositories/repo/pulls");

    const sidebar = within(screen.getByRole("complementary", { name: "Primary" }));
    const repositorySwitcher = sidebar.getByRole("button", {
      name: /LoongBoard acme\/project/,
    });
    expect(repositorySwitcher).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(repositorySwitcher);
    expect(repositorySwitcher).toHaveAttribute("aria-expanded", "false");
    expect(sidebar.queryByRole("link", { name: "Pull requests" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Navigate away" }));
    fireEvent.click(screen.getByRole("button", { name: "Navigate back" }));

    expect(repositorySwitcher).toHaveAttribute("aria-expanded", "false");
    expect(sidebar.queryByRole("link", { name: "Pull requests" })).not.toBeInTheDocument();
  });

  it("uses one direct Settings link without a section popup", () => {
    renderSidebar("/");

    const sidebar = within(screen.getByRole("complementary", { name: "Primary" }));
    const settingsLink = sidebar.getByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveAttribute("href", "/settings");
    expect(settingsLink).not.toHaveAttribute("aria-expanded");
    expect(sidebar.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    expect(sidebar.getAllByRole("link", { name: "Settings" })).toHaveLength(1);
  });

  it("does not render the old footer mark or copy", () => {
    renderSidebar("/");

    const sidebar = within(screen.getByRole("complementary", { name: "Primary" }));
    expect(sidebar.queryByText("Local-first · single user")).not.toBeInTheDocument();
    expect(document.querySelector(".sidebar__footer-mark")).toBeNull();
  });

  it("keeps only icons visible in compact mode and exposes a restore control", () => {
    const { onToggleCompact } = renderCompactSidebar("/");
    const sidebar = screen.getByRole("complementary", { name: "Primary" });
    expect(sidebar).toHaveClass("sidebar--compact");
    expect(sidebar.querySelector(".sidebar-nav__icon.codicon-home")).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-settings__icon")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onToggleCompact).toHaveBeenCalledTimes(1);
  });
});
