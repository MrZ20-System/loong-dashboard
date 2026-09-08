import { useLocation } from "react-router-dom";
import { useRepositories } from "../app/hooks";
import { RepositorySyncStatus } from "../components/repository/RepositorySyncStatus";

interface HeaderContext {
  eyebrow: string;
  title: string;
  repositoryId: string | null;
}

const repositoryPath = /^\/repositories\/([^/]+)(?:\/(pulls|issues)(?:\/(\d+))?)?/;

function repositorySection(
  match: RegExpMatchArray | null,
): HeaderContext | null {
  if (match === null) return null;
  const repositoryId = decodeURIComponent(match[1] ?? "");
  const kind = match[2] ?? null;
  const number = match[3] ?? null;
  let title = "Activity";
  if (kind === "pulls") title = number ? `Pull request #${number}` : "Pull requests";
  if (kind === "issues") title = number ? `Issue #${number}` : "Issues";
  return { eyebrow: "Repository", title, repositoryId };
}

function globalContext(pathname: string): HeaderContext {
  if (pathname.startsWith("/knowledge"))
    return { eyebrow: "Workspace", title: "Knowledge", repositoryId: null };
  if (pathname.startsWith("/settings/schedules") || pathname.startsWith("/scheduled-tasks"))
    return { eyebrow: "Settings", title: "Schedules", repositoryId: null };
  if (pathname.startsWith("/settings/domains"))
    return { eyebrow: "Settings", title: "Domains", repositoryId: null };
  if (pathname.startsWith("/settings/health") || pathname.startsWith("/health"))
    return { eyebrow: "Settings", title: "Health", repositoryId: null };
  if (pathname.startsWith("/settings"))
    return { eyebrow: "Settings", title: "Settings", repositoryId: null };
  if (pathname === "/")
    return { eyebrow: "Workspace", title: "Board", repositoryId: null };
  return { eyebrow: "Workspace", title: "LoongBoard", repositoryId: null };
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: "light" | "dark";
  onChange: (theme: "light" | "dark") => void;
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      <button
        type="button"
        className={theme === "light" ? "theme-toggle__item theme-toggle__item--active" : "theme-toggle__item"}
        aria-pressed={theme === "light"}
        onClick={() => onChange("light")}
      >
        Light
      </button>
      <button
        type="button"
        className={theme === "dark" ? "theme-toggle__item theme-toggle__item--active" : "theme-toggle__item"}
        aria-pressed={theme === "dark"}
        onClick={() => onChange("dark")}
      >
        Dark
      </button>
    </div>
  );
}

export function ContextHeader({
  sidebarOpen,
  onMenuClick,
  theme,
  onThemeChange,
}: {
  sidebarOpen: boolean;
  onMenuClick: () => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  const location = useLocation();
  const repositories = useRepositories();
  const repoContext = repositorySection(location.pathname.match(repositoryPath));
  const fallback = globalContext(location.pathname);
  const repository = repositories.data?.items.find(
    (item) => item.id === repoContext?.repositoryId,
  );
  const eyebrow = repository
    ? `${repository.githubOwner}/${repository.githubName}`
    : repoContext !== null
      ? "Repository"
      : fallback.eyebrow;
  const title = repository
    ? `${repository.displayName} · ${repoContext?.title ?? "Repository"}`
    : repoContext !== null
      ? repoContext.title
      : fallback.title;

  return (
    <header className="topbar topbar--context">
      <button
        type="button"
        className="topbar__menu"
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        onClick={onMenuClick}
      >
        <span aria-hidden="true">≡</span>
        <span>Menu</span>
      </button>
      <span className="topbar__context-mark" aria-hidden="true">
        {repository
          ? repository.displayName.slice(0, 1).toUpperCase()
          : fallback.eyebrow === "Settings"
            ? "S"
            : "LB"}
      </span>
      <div className="topbar__context">
        <span>{eyebrow}</span>
        <strong>{title}</strong>
      </div>
      <div className="topbar__spacer" />
      {repoContext?.repositoryId && repository !== undefined && (
        <RepositorySyncStatus repositoryId={repoContext.repositoryId} />
      )}
      <ThemeToggle theme={theme} onChange={onThemeChange} />
    </header>
  );
}
