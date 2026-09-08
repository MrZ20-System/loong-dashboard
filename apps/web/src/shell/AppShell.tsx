import { useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { KnowledgePage } from "../knowledge";
import { AppThemeContext } from "../knowledge-editor";
import { ScheduledTasksPage } from "../scheduled-tasks";
import { IssueDetailPage } from "../issue-detail";
import { PullRequestDetailPage } from "../pull-request-detail";
import { BoardPage } from "../features/board/BoardPage";
import { MetadataPage } from "../features/community/MetadataPage";
import { RepositoryActivityPage } from "../features/community/RepositoryActivityPage";
import { DomainsSettingsPage } from "../features/settings/DomainsSettingsPage";
import { SettingsShell } from "../features/settings/SettingsShell";
import { HealthPage } from "../features/system/HealthPage";
import { AppSidebar } from "./AppSidebar";
import { ContextHeader } from "./ContextHeader";
import { NotFoundPage } from "./NotFoundPage";

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const location = useLocation();
  // PR detail is a dedicated full-viewport diff workbench: keep the route but
  // remove the app chrome so the diff owns the whole viewport.
  const prFocus =
    location.pathname.match(/^\/repositories\/[^/]+\/pulls\/\d+\/?$/) !== null;
  return (
    <AppThemeContext.Provider value={theme}>
      <div
        className={`app-shell${prFocus ? " app-shell--pr-focus" : ""}`}
        data-theme={theme}
      >
        {!prFocus && (
          <AppSidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            compact={sidebarCompact}
            onToggleCompact={() => setSidebarCompact((compact) => !compact)}
          />
        )}
        {!prFocus && sidebarOpen && (
          <div
            className="sidebar-backdrop"
            role="presentation"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={`main-canvas${prFocus ? " main-canvas--pr-focus" : ""}${!prFocus && sidebarCompact ? " main-canvas--sidebar-compact" : ""}`}
        >
          {!prFocus && (
            <ContextHeader
              sidebarOpen={sidebarOpen}
              onMenuClick={() => setSidebarOpen((open) => !open)}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}
          <main
            className={`app-content${prFocus ? " app-content--pr-focus" : ""}`}
          >
            <Routes>
              <Route path="/" element={<BoardPage />} />
              <Route path="/health" element={<Navigate to="/settings/health" replace />} />
              <Route
                path="/settings"
                element={<Navigate to="/settings/domains" replace />}
              />
              <Route
                path="/settings/domains"
                element={
                  <SettingsShell>
                    <DomainsSettingsPage />
                  </SettingsShell>
                }
              />
              <Route
                path="/settings/schedules"
                element={
                  <SettingsShell>
                    <ScheduledTasksPage />
                  </SettingsShell>
                }
              />
              <Route
                path="/settings/health"
                element={
                  <SettingsShell>
                    <HealthPage />
                  </SettingsShell>
                }
              />
              <Route
                path="/scheduled-tasks"
                element={
                  <SettingsShell>
                    <ScheduledTasksPage />
                  </SettingsShell>
                }
              />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/knowledge/:documentId" element={<KnowledgePage />} />
              <Route
                path="/repositories/:repositoryId/pulls"
                element={<MetadataPage kind="pulls" />}
              />
              <Route
                path="/repositories/:repositoryId"
                element={<RepositoryActivityPage />}
              />
              <Route
                path="/repositories/:repositoryId/issues"
                element={<MetadataPage kind="issues" />}
              />
              <Route
                path="/repositories/:repositoryId/pulls/:number"
                element={<PullRequestDetailPage />}
              />
              <Route
                path="/repositories/:repositoryId/issues/:number"
                element={<IssueDetailPage />}
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
          {!prFocus && (
            <footer className="app-footer">
              LoongBoard · local-first engineering workspace
            </footer>
          )}
        </div>
      </div>
    </AppThemeContext.Provider>
  );
}
