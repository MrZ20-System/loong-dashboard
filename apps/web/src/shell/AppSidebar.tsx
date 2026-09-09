import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useRepositories } from "../app/hooks";
import type { RepositorySummary } from "../metadata-client";
import "./app-sidebar-refinements.css";

const workspaceLinks = [
  { to: "/", label: "Board", icon: "home", end: true },
  { to: "/agent", label: "Agent", icon: "sparkle", end: false },
  { to: "/knowledge", label: "Knowledge", icon: "book", end: false },
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
  const location = useLocation();
  const activeId = activeRepositoryId(location.pathname);
  const isActive = activeId === repositoryId;
  const counts = repository as RepositorySummary & { pullRequestCount?: number; issueCount?: number };
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
        aria-label={compact ? `Expand navigation for ${repository.displayName}` : undefined}
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
          aria-label={`${repository.displayName} sections`}
        >
          <NavLink to={`/repositories/${encodeURIComponent(repositoryId)}`} end>
            Activity
          </NavLink>
          <NavLink
            to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}
          >
            Pull requests{typeof counts.pullRequestCount === "number" && <span className="sidebar-count">{counts.pullRequestCount}</span>}
          </NavLink>
          <NavLink
            to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}
          >
            Issues{typeof counts.issueCount === "number" && <span className="sidebar-count">{counts.issueCount}</span>}
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
      aria-label="Primary"
    >
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true">
          LB
        </span>
        <div className="sidebar__brand-copy">
          <strong>LoongBoard</strong>
          <span>Local engineering board</span>
        </div>
        <button
          type="button"
          className="sidebar__close"
          aria-label="Close navigation menu"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <nav className="sidebar__nav" aria-label="Primary navigation">
        <p className="sidebar__eyebrow">Workspace</p>
        <ul className="sidebar-nav-list">
          {workspaceLinks.map(({ to, label, icon, end }) => (
            <li key={label}>
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
                <span className="sidebar-nav__label">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        {repositories.isPending && (
          <p role="status" className="sidebar-note">
            Loading repositories…
          </p>
        )}
        {repositories.isError && (
          <p role="alert" className="sidebar-note">
            {repositories.error.message}
          </p>
        )}
        {repositories.data !== undefined && repositories.data.items.length > 0 && (
          <>
            <p className="sidebar__eyebrow sidebar__eyebrow--repositories">
              Repositories
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
            title={compact ? "Settings" : undefined}
          >
            <span
              className="sidebar-settings__icon codicon codicon-settings-gear"
              aria-hidden="true"
            />
            <span className="sidebar-settings__label">Settings</span>
          </NavLink>
        </div>
        <button
          type="button"
          className="sidebar__compact-toggle"
          aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={compact}
          onClick={onToggleCompact}
          title={compact ? "Expand sidebar" : "Collapse sidebar"}
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
