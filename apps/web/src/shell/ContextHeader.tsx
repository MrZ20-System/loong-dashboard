import { useLocation } from "react-router-dom";
import { useRepositories } from "../app/hooks";
import { RepositorySyncStatus } from "../components/repository/RepositorySyncStatus";
import { useI18n, type LocalizedMessage, type MessageValues } from "../i18n";
import { AppearanceControls } from "./AppearanceControls";
import { shellMessages } from "./messages";

interface HeaderContext {
  eyebrow: LocalizedMessage;
  title: LocalizedMessage;
  titleValues?: MessageValues;
  repositoryId: string | null;
}

const repositoryPath = /^\/repositories\/([^/]+)(?:\/(pulls|merged|issues)(?:\/(\d+))?)?/;

function repositorySection(
  match: RegExpMatchArray | null,
): HeaderContext | null {
  if (match === null) return null;
  const repositoryId = decodeURIComponent(match[1] ?? "");
  const kind = match[2] ?? null;
  const number = match[3] ?? null;
  let title = shellMessages.activity;
  let titleValues: MessageValues | undefined;
  if (kind === "pulls") {
    title = number ? shellMessages.pullRequestNumber : shellMessages.pullRequests;
    titleValues = number ? { number } : undefined;
  }
  if (kind === "merged") title = shellMessages.merged;
  if (kind === "issues") {
    title = number ? shellMessages.issueNumber : shellMessages.issues;
    titleValues = number ? { number } : undefined;
  }
  return { eyebrow: shellMessages.repository, title, titleValues, repositoryId };
}

function globalContext(pathname: string): HeaderContext {
  if (pathname.startsWith("/agent"))
    return { eyebrow: shellMessages.workspace, title: shellMessages.agent, repositoryId: null };
  if (pathname.startsWith("/knowledge"))
    return { eyebrow: shellMessages.workspace, title: shellMessages.knowledge, repositoryId: null };
  if (pathname.startsWith("/settings/schedules") || pathname.startsWith("/scheduled-tasks"))
    return { eyebrow: shellMessages.settings, title: shellMessages.schedules, repositoryId: null };
  if (pathname.startsWith("/settings/domains"))
    return { eyebrow: shellMessages.settings, title: shellMessages.domains, repositoryId: null };
  if (pathname.startsWith("/settings/health") || pathname.startsWith("/health"))
    return { eyebrow: shellMessages.settings, title: shellMessages.health, repositoryId: null };
  if (pathname.startsWith("/settings/security"))
    return { eyebrow: shellMessages.settings, title: shellMessages.security, repositoryId: null };
  if (pathname.startsWith("/settings"))
    return { eyebrow: shellMessages.settings, title: shellMessages.settings, repositoryId: null };
  if (pathname === "/")
    return { eyebrow: shellMessages.workspace, title: shellMessages.board, repositoryId: null };
  return { eyebrow: shellMessages.workspace, title: shellMessages.loongBoard, repositoryId: null };
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
  const { t } = useI18n();
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
      ? t(shellMessages.repository)
      : t(fallback.eyebrow);
  const title = repository
    ? `${repository.displayName} · ${t(repoContext?.title ?? shellMessages.repository, repoContext?.titleValues)}`
    : repoContext !== null
      ? t(repoContext.title, repoContext.titleValues)
      : t(fallback.title);

  return (
    <header className="topbar topbar--context">
      <button
        type="button"
        className="topbar__menu"
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        aria-label={sidebarOpen ? t(shellMessages.closeNavigation) : t(shellMessages.openNavigation)}
        onClick={onMenuClick}
      >
        <span aria-hidden="true">≡</span>
        <span>{t(shellMessages.menu)}</span>
      </button>
      <span className="topbar__context-mark" aria-hidden="true">
        {repository
          ? repository.displayName.slice(0, 1).toUpperCase()
          : fallback.eyebrow === shellMessages.settings
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
      <AppearanceControls theme={theme} onThemeChange={onThemeChange} />
    </header>
  );
}
