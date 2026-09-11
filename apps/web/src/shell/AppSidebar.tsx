import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useRepositories } from "../app/hooks";
import type { RepositorySummary } from "../metadata-client";
import { useI18n } from "../i18n";
import { shellMessages } from "./messages";
import "./app-sidebar-refinements.css";

const workspaceLinks = [
  { to: "/", label: shellMessages.board, icon: "home", end: true },
  { to: "/agent", label: shellMessages.agent, icon: "sparkle", end: false },
  { to: "/knowledge", label: shellMessages.knowledge, icon: "book", end: false },
] as const;

function activeRepositoryId(pathname: string): string | null {
  const match = pathname.match(/^\/repositories\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function RepositoryGroup({
  repository,
  compact,
  onExpandSidebar,
}: {
  repository: RepositorySummary;
  compact: boolean;
  onExpandSidebar: () => void;
}) {
  const repositoryId = repository.id;
  const { t, formatNumber } = useI18n();
  const location = useLocation();
  const activeId = activeRepositoryId(location.pathname);
  const isActive = activeId === repositoryId;
  const counts = repository as RepositorySummary & { pullRequestCount?: number; issueCount?: number; mergedPullRequestCount?: number };
  const [expanded, setExpanded] = useState(() => isActive);
  return (
    <section
      className={`sidebar-repo${isActive ? " sidebar-repo--active" : ""}${
        expanded ? " sidebar-repo--expanded" : ""
      }`}
    >
      <button
        type="button"
        className="sidebar-repo__switcher"
        aria-expanded={expanded}
        aria-label={compact ? t(shellMessages.expandNavigationFor, { repository: repository.displayName }) : undefined}
        title={compact ? repository.displayName : undefined}
        onClick={() => {
          if (compact) onExpandSidebar();
          else setExpanded((current) => !current);
        }}
      >
        <span className="sidebar-repo__mark" aria-hidden="true">
          {repository.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="sidebar-repo__copy">
          <strong title={repository.displayName}>{repository.displayName}</strong>
          <small>
            {repository.githubOwner}/{repository.githubName}
          </small>
        </span>
        <span className="sidebar-repo__chevron" aria-hidden="true">
          {expanded ? "⌄" : "›"}
        </span>
      </button>
      {expanded && !compact && (
        <nav
          className="sidebar-repo__subnav"
          aria-label={t(shellMessages.repositorySections, { repository: repository.displayName })}
        >
          <NavLink to={`/repositories/${encodeURIComponent(repositoryId)}`} end>
            {t(shellMessages.activity)}
          </NavLink>
          <NavLink
            to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}
          >
            {t(shellMessages.pullRequests)}{typeof counts.pullRequestCount === "number" && <span className="sidebar-count">{formatNumber(counts.pullRequestCount)}</span>}
          </NavLink>
          <NavLink to={`/repositories/${encodeURIComponent(repositoryId)}/merged`}>
            {t(shellMessages.merged)}{typeof counts.mergedPullRequestCount === "number" && <span className="sidebar-count">{formatNumber(counts.mergedPullRequestCount)}</span>}
          </NavLink>
          <NavLink
            to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}
          >
            {t(shellMessages.issues)}{typeof counts.issueCount === "number" && <span className="sidebar-count">{formatNumber(counts.issueCount)}</span>}
          </NavLink>
        </nav>
      )}
    </section>
  );
}

export function AppSidebar({
  open,
  onClose,
  compact = false,
  onToggleCompact = () => undefined,
}: {
  open: boolean;
  onClose: () => void;
  compact?: boolean;
  onToggleCompact?: () => void;
}) {
  const { t } = useI18n();
  const repositories = useRepositories();
  const location = useLocation();
  const settingsActive =
    location.pathname.startsWith("/settings") ||
    location.pathname === "/health" ||
    location.pathname.startsWith("/scheduled-tasks");
  return (
    <aside
      className={`sidebar${open ? " sidebar--open" : ""}${compact ? " sidebar--compact" : ""}`}
      id="app-sidebar"
      aria-label={t(shellMessages.primary)}
    >
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true">
          LB
        </span>
        <div className="sidebar__brand-copy">
          <strong>LoongBoard</strong>
          <span>{t(shellMessages.localEngineeringBoard)}</span>
        </div>
        <button
          type="button"
          className="sidebar__close"
          aria-label={t(shellMessages.closeNavigationMenu)}
          onClick={onClose}
        >
          {t(shellMessages.closeNavigation)}
        </button>
      </div>
      <nav className="sidebar__nav" aria-label={t(shellMessages.primaryNavigation)}>
        <p className="sidebar__eyebrow">{t(shellMessages.workspace)}</p>
        <ul className="sidebar-nav-list">
          {workspaceLinks.map(({ to, label, icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                onClick={onClose}
                className={({ isActive }) =>
                  isActive
                    ? "sidebar-nav__item sidebar-nav__item--active"
                    : "sidebar-nav__item"
                }
              >
                <span className={`sidebar-nav__icon codicon codicon-${icon}`} aria-hidden="true">{icon === "sparkle" ? "✦" : null}</span>
                <span className="sidebar-nav__label">{t(label)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        {repositories.isPending && (
          <p role="status" className="sidebar-note">
            {t(shellMessages.loadingRepositories)}
          </p>
        )}
        {repositories.isError && (
          <p role="alert" className="sidebar-note">
            {t(shellMessages.unableLoadRepositories, { detail: repositories.error.message })}
          </p>
        )}
        {repositories.data !== undefined && repositories.data.items.length > 0 && (
          <>
            <p className="sidebar__eyebrow sidebar__eyebrow--repositories">
              {t(shellMessages.repositories)}
            </p>
            {repositories.data.items.map((repository) => (
              <RepositoryGroup
                key={repository.id}
                repository={repository}
                compact={compact}
                onExpandSidebar={onToggleCompact}
              />
            ))}
          </>
        )}
      </nav>
      <div className="sidebar__footer">
        <div className="sidebar-settings">
          <NavLink
            to="/settings"
            className={
              settingsActive
                ? "sidebar-settings__trigger sidebar-settings__trigger--active"
                : "sidebar-settings__trigger"
            }
            onClick={onClose}
            title={compact ? t(shellMessages.settings) : undefined}
          >
            <span
              className="sidebar-settings__icon codicon codicon-settings-gear"
              aria-hidden="true"
            />
            <span className="sidebar-settings__label">{t(shellMessages.settings)}</span>
          </NavLink>
        </div>
        <button
          type="button"
          className="sidebar__compact-toggle"
          aria-label={compact ? t(shellMessages.expandSidebar) : t(shellMessages.collapseSidebar)}
          aria-pressed={compact}
          onClick={onToggleCompact}
          title={compact ? t(shellMessages.expandSidebar) : t(shellMessages.collapseSidebar)}
        >
          <span
            className={`codicon ${compact ? "codicon-layout-sidebar-left" : "codicon-layout-sidebar-left-off"}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </aside>
  );
}
