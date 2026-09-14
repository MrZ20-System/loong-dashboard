import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { fetchAuthStatus, unlockAuth } from "./auth-client";
import { AUTH_REQUIRED_EVENT } from "./auth-required-event";
import { App, appQueryClient } from "./App";
import { useRepositories } from "./app/hooks";
import { LOCALE_STORAGE_KEY } from "./i18n";
import type { RepositorySummary } from "./metadata-client";

vi.mock("./auth-client", () => ({
  fetchAuthStatus: vi.fn(),
  unlockAuth: vi.fn(),
}));

vi.mock("./app/hooks", () => ({
  useRepositories: vi.fn(),
}));

vi.mock("./components/repository/RepositorySyncStatus", () => ({
  RepositorySyncStatus: () => <span role="status">Sync status</span>,
}));

vi.mock("./features/agent/AgentPage", () => ({
  AgentPage: () => <h1>Agent route</h1>,
}));

vi.mock("./features/agent/GlobalAgentDock", () => ({
  GlobalAgentDock: () => <div data-testid="agent-dock" />,
}));

vi.mock("./features/board/BoardPage", () => ({
  BoardPage: () => <h1>Board route</h1>,
}));

vi.mock("./features/community/MetadataPage", () => ({
  MetadataPage: ({ kind }: { kind: "pulls" | "issues" }) => (
    <h1>{kind === "pulls" ? "Pull requests route" : "Issues route"}</h1>
  ),
}));

vi.mock("./features/community/MergedPage", () => ({
  MergedPage: () => <h1>Merged route</h1>,
}));

vi.mock("./features/community/RepositoryActivityPage", () => ({
  RepositoryActivityPage: () => <h1>Activity route</h1>,
}));

vi.mock("./features/settings/DomainsSettingsPage", () => ({
  DomainsSettingsPage: () => <h1>Domains route</h1>,
}));

vi.mock("./features/settings/SecuritySettings", () => ({
  SecuritySettings: () => <h1>Security route</h1>,
}));

vi.mock("./features/settings/SettingsShell", () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./features/settings/SettingsControlCenter", () => ({
  SettingsControlCenter: () => <h1>Settings route</h1>,
  RepositoriesSettings: () => <h1>Repositories settings route</h1>,
  IntegrationsSettings: () => <h1>Integrations settings route</h1>,
  AgentSettings: () => <h1>Agent settings route</h1>,
  PersonalDataSection: () => <h1>Personal Data settings route</h1>,
  PersonalDataSettingsPage: () => <h1>Personal Data settings route</h1>,
  KnowledgeCheckpointSettingsPage: () => <h1>Checkpoint settings route</h1>,
  CodeBackupSettingsPage: () => <h1>Code backup settings route</h1>,
}));

vi.mock("./features/system/HealthPage", () => ({
  HealthPage: () => <h1>Health route</h1>,
}));

vi.mock("./issue-detail", () => ({
  IssueDetailPage: () => <h1>Issue detail route</h1>,
}));

vi.mock("./knowledge", () => ({
  KnowledgePage: () => <h1>Knowledge route</h1>,
}));

vi.mock("./pull-request-detail", () => ({
  PullRequestDetailPage: () => <h1>Pull request detail route</h1>,
}));

vi.mock("./scheduled-tasks", () => ({
  ScheduledTasksPage: () => <h1>Schedules route</h1>,
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
  mergedPullRequestCount: 4,
};

const repositoriesQuery = {
  data: { items: [repository] },
  isPending: false,
  isError: false,
  error: null,
} as ReturnType<typeof useRepositories>;

const unlockedStatus = { enabled: false, unlocked: true };

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } as Storage,
  });
}

beforeEach(() => {
  installStorage();
});

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

describe("App AuthGate integration", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(unlockedStatus);
    vi.mocked(unlockAuth).mockResolvedValue(unlockedStatus);
    vi.mocked(useRepositories).mockReturnValue(repositoriesQuery);
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.clearAllMocks();
  });

  it("keeps the App shell behind the lock until the user unlocks", async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ enabled: true, unlocked: false });
    vi.mocked(unlockAuth).mockResolvedValue({ enabled: true, unlocked: true });

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "LoongBoard" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();
    expect(unlockAuth).toHaveBeenCalledWith("secret");
  });

  it("removes the mounted shell when a business request requires authentication", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();

    fireEvent(window, new Event(AUTH_REQUIRED_EVENT));

    await waitFor(() => {
      expect(screen.queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "LoongBoard" })).toBeInTheDocument();
  });
});

describe("App shell", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(unlockedStatus);
    vi.mocked(useRepositories).mockReturnValue(repositoriesQuery);
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.clearAllMocks();
  });

  it("renders the shared shell around the active route and supports the theme toggle", async () => {
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText("LoongBoard · local-first engineering workspace")).toBeInTheDocument();

    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-theme", "light");
    const lightThemeButton = screen.getByRole("button", { name: "Light theme" });
    const darkThemeButton = screen.getByRole("button", { name: "Dark theme" });
    expect(lightThemeButton).toHaveAttribute("title", "Light theme");
    expect(lightThemeButton).toHaveAttribute("aria-pressed", "true");
    expect(darkThemeButton).toHaveAttribute("title", "Dark theme");
    expect(darkThemeButton).toHaveAttribute("aria-pressed", "false");
    expect(lightThemeButton).toHaveTextContent("☀");
    expect(darkThemeButton).toHaveTextContent("☾");
    fireEvent.click(darkThemeButton);
    expect(shell).toHaveAttribute("data-theme", "dark");
    expect(darkThemeButton).toHaveAttribute("aria-pressed", "true");
  });

  it("localizes the shared footer while keeping the product name unchanged", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();
    expect(screen.getByText("LoongBoard · 本地优先的工程工作空间")).toBeInTheDocument();
  });

  it("restores persisted theme and compact sidebar preferences", async () => {
    const previousTheme = localStorage.getItem("loongboard.theme");
    const previousCompact = localStorage.getItem("loongboard.sidebar-compact");
    localStorage.setItem("loongboard.theme", "dark");
    localStorage.setItem("loongboard.sidebar-compact", "true");

    try {
      renderApp("/");

      expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();
      expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "dark");
      expect(screen.getByRole("complementary", { name: "Primary" })).toHaveClass("sidebar--compact");
    } finally {
      cleanup();
      if (previousTheme === null) localStorage.removeItem("loongboard.theme");
      else localStorage.setItem("loongboard.theme", previousTheme);
      if (previousCompact === null) localStorage.removeItem("loongboard.sidebar-compact");
      else localStorage.setItem("loongboard.sidebar-compact", previousCompact);
    }
  });

  it.each([
    ["/repositories/repo/pulls/5", "Pull request detail route"],
    ["/repositories/repo/issues/7", "Issue detail route"],
  ])("keeps fullscreen %s routes equipped with appearance controls", async (path, heading) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color theme" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "dark");
    fireEvent.click(screen.getByRole("button", { name: "Chinese" }));
    expect(screen.getByTestId("location-path")).toHaveTextContent(path);
    expect(screen.getByRole("group", { name: "配色主题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深色主题" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("App router", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(unlockedStatus);
    vi.mocked(useRepositories).mockReturnValue(repositoriesQuery);
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.clearAllMocks();
  });

  it.each([
    ["/", "Board route"],
    ["/agent", "Agent route"],
    ["/knowledge", "Knowledge route"],
    ["/settings", "Settings route"],
    ["/settings/personal-data", "Personal Data settings route"],
    ["/settings/checkpoint", "Personal Data settings route"],
    ["/settings/health", "Health route"],
    ["/health", "Health route"],
    ["/repositories/repo", "Activity route"],
    ["/repositories/repo/pulls", "Pull requests route"],
    ["/repositories/repo/merged", "Merged route"],
    ["/repositories/repo/issues", "Issues route"],
  ])("routes %s to the expected feature boundary", async (path, heading) => {
    renderApp(path);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });
});

describe("primary navigation", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(unlockedStatus);
    vi.mocked(useRepositories).mockReturnValue(repositoriesQuery);
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.clearAllMocks();
  });

  it("exposes workspace links and the active repository sections", async () => {
    renderApp("/repositories/repo/issues");

    const nav = await screen.findByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getByRole("link", { name: "Board" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Agent" })).toHaveAttribute("href", "/agent");
    expect(within(nav).getByRole("link", { name: "Knowledge" })).toHaveAttribute("href", "/knowledge");

    const repositorySections = within(nav).getByRole("navigation", { name: "LoongBoard sections" });
    expect(within(repositorySections).getByRole("link", { name: "Activity" })).toHaveAttribute(
      "href",
      "/repositories/repo",
    );
    expect(within(repositorySections).getByRole("link", { name: "Pull requests" })).toHaveAttribute(
      "href",
      "/repositories/repo/pulls",
    );
    expect(within(repositorySections).getByRole("link", { name: "Issues" })).toHaveAttribute("aria-current", "page");
    expect(within(repositorySections).getByRole("link", { name: /Merged 4/ })).toHaveAttribute(
      "href",
      "/repositories/repo/merged",
    );
  });

  it("opens and closes the mobile navigation drawer", async () => {
    renderApp("/");

    const menu = await screen.findByRole("button", { name: "Open navigation" });
    const sidebar = screen.getByRole("complementary", { name: "Primary" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(sidebar).not.toHaveClass("sidebar--open");

    fireEvent.click(menu);

    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).toHaveClass("sidebar--open");
    expect(screen.getByRole("button", { name: "Close navigation menu" })).toBeInTheDocument();
  });
});

describe("NotFound route", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(unlockedStatus);
    vi.mocked(useRepositories).mockReturnValue(repositoriesQuery);
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.clearAllMocks();
  });

  it("renders the not-found boundary and can return to the board", async () => {
    renderApp("/does-not-exist");

    expect(await screen.findByRole("heading", { name: "This LoongBoard route does not exist." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Return to the board" }));
    expect(await screen.findByRole("heading", { name: "Board route" })).toBeInTheDocument();
  });
});
