import { useEffect, useState } from "react";
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
import { MergedPage } from "../features/community/MergedPage";
import { RepositoryActivityPage } from "../features/community/RepositoryActivityPage";
import { DomainsSettingsPage } from "../features/settings/DomainsSettingsPage";
import { SettingsShell } from "../features/settings/SettingsShell";
import { AgentSettings, IntegrationsSettings, RepositoriesSettings, SettingsControlCenter, PersonalDataSettingsPage, CodeBackupSettingsPage } from "../features/settings/SettingsControlCenter";
import { HealthPage } from "../features/system/HealthPage";
import { SecuritySettings } from "../features/settings/SecuritySettings";
import { AppSidebar } from "./AppSidebar";
import { ContextHeader } from "./ContextHeader";
import { AppearanceControls } from "./AppearanceControls";
import { NotFoundPage } from "./NotFoundPage";
import { AgentPage } from "../features/agent/AgentPage";
import { GlobalAgentDock } from "../features/agent/GlobalAgentDock";
import { AgentSessionSelectionProvider } from "../features/agent/agent-session-context";
import { useI18n } from "../i18n";
import { shellMessages } from "./messages";

const THEME_STORAGE_KEY = "loongboard.theme";
const SIDEBAR_COMPACT_STORAGE_KEY = "loongboard.sidebar-compact";

function readStoredTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function readStoredSidebarCompact(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COMPACT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function AppShell() {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(readStoredSidebarCompact);
  const [theme, setTheme] = useState<"light" | "dark">(readStoredTheme);
  const location = useLocation();
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; the current session remains usable.
    }
  }, [theme]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        SIDEBAR_COMPACT_STORAGE_KEY,
        String(sidebarCompact),
      );
    } catch {
      // Persistence is best-effort; the current session remains usable.
    }
  }, [sidebarCompact]);
  // PR detail is a dedicated full-viewport diff workbench: keep the route but
  // remove the app chrome so the diff owns the whole viewport.
  const prFocus =
    location.pathname.match(/^\/repositories\/[^/]+\/pulls\/\d+\/?$/) !== null;
  const issueFocus =
    location.pathname.match(/^\/repositories\/[^/]+\/issues\/\d+\/?$/) !== null;
  const focusRoute = prFocus || issueFocus;
  return (
    <AppThemeContext.Provider value={theme}>
      <AgentSessionSelectionProvider>
      <div
        className={`app-shell${prFocus ? " app-shell--pr-focus" : ""}${issueFocus ? " app-shell--issue-focus" : ""}`}
        data-theme={theme}
      >
        {!focusRoute && (
          <AppSidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            compact={sidebarCompact}
            onToggleCompact={() => setSidebarCompact((compact) => !compact)}
          />
        )}
        {!focusRoute && sidebarOpen && (
          <div
            className="sidebar-backdrop"
            role="presentation"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={`main-canvas${prFocus ? " main-canvas--pr-focus" : ""}${issueFocus ? " main-canvas--issue-focus" : ""}${!focusRoute && sidebarCompact ? " main-canvas--sidebar-compact" : ""}`}
        >
          {focusRoute && (
            <div className="focus-appearance-bar">
              <AppearanceControls theme={theme} onThemeChange={setTheme} />
            </div>
          )}
          {!focusRoute && (
            <ContextHeader
              sidebarOpen={sidebarOpen}
              onMenuClick={() => setSidebarOpen((open) => !open)}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}
          <main
            className={`app-content${prFocus ? " app-content--pr-focus" : ""}${issueFocus ? " app-content--issue-focus" : ""}`}
          >
            <Routes>
              <Route path="/" element={<BoardPage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/health" element={<Navigate to="/settings/health" replace />} />
              <Route
                path="/settings"
                element={<SettingsShell><SettingsControlCenter /></SettingsShell>}
              />
              <Route path="/settings/repositories" element={<SettingsShell><RepositoriesSettings /></SettingsShell>} />
              <Route path="/settings/integrations" element={<SettingsShell><IntegrationsSettings /></SettingsShell>} />
              <Route path="/settings/agent" element={<SettingsShell><AgentSettings /></SettingsShell>} />
              <Route path="/settings/personal-data" element={<SettingsShell><PersonalDataSettingsPage /></SettingsShell>} />
              <Route path="/settings/checkpoint" element={<Navigate to="/settings/personal-data" replace />} />
              <Route path="/settings/code-backup" element={<SettingsShell><CodeBackupSettingsPage /></SettingsShell>} />
              <Route path="/settings/security" element={<SettingsShell><SecuritySettings /></SettingsShell>} />
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
                path="/repositories/:repositoryId/merged"
                element={<MergedPage />}
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
          {!focusRoute && <GlobalAgentDock />}
          {!focusRoute && (
            <footer className="app-footer">
              {t(shellMessages.localFirstEngineeringWorkspace)}
            </footer>
          )}
        </div>
      </div>
      </AgentSessionSelectionProvider>
    </AppThemeContext.Provider>
  );
}
