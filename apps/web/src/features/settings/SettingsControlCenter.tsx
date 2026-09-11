import { Link } from "react-router-dom";

export function SettingsControlCenter() {
  return (
    <section className="settings-control-center" aria-labelledby="settings-control-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Control center</p>
          <h2 id="settings-control-heading">Workspace settings</h2>
          <p className="page-subtitle">Manage repositories, credentials, runtime defaults, files and scheduled work.</p>
        </div>
      </div>
      <div className="settings-control-grid">
        <article className="settings-control-tile"><span className="settings-tile-icon">↻</span><h3>Repositories</h3><p>Sync status and automatic frequency for each configured repository.</p><Link to="/settings/repositories">Manage repositories</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⌁</span><h3>Integrations</h3><p>Verify GitHub access and quota without exposing secrets.</p><Link to="/settings/integrations">Manage integrations</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">✦</span><h3>Agent</h3><p>Runtime health, dynamic defaults and idle retention.</p><Link to="/settings/agent">Configure Agent</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">◇</span><h3>Domains</h3><p>Edit rendered rules, JSON source and update prompts.</p><Link to="/settings/domains">Open Domains</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">◷</span><h3>Schedules</h3><p>Review Agent and system schedules and run history.</p><Link to="/settings/schedules">Open Schedules</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">♥</span><h3>Health</h3><p>Check the API and runtime boundary.</p><Link to="/settings/health">Open Health</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">✓</span><h3>Knowledge checkpoint</h3><p>Configure the existing Knowledge commit and push behavior.</p><Link to="/settings/checkpoint">Manage checkpoint</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⇧</span><h3>Code backup</h3><p>Protect the LoongBoard source repository with separate checkpoint and push cadence.</p><Link to="/settings/code-backup">Manage code backup</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⌑</span><h3>Security</h3><p>Enable or change the local password lock for Web/API access.</p><Link to="/settings/security">Manage password lock</Link></article>
      </div>
    </section>
  );
}

// Keep the existing route/test imports stable while each settings area owns its
// own query, mutation, and rendering logic.
export { HistorySyncSection } from "./RepositorySettingsSection";
export { RepositorySettingsSection, RepositorySettingsSection as RepositoriesSettings } from "./RepositorySettingsSection";
export { GitHubSettingsSection, GitHubSettingsSection as IntegrationsSettings } from "./GitHubSettingsSection";
export { AgentSettingsSection, AgentSettingsSection as AgentSettings } from "./AgentSettingsSection";
export { KnowledgeBackupSection, KnowledgeBackupSection as KnowledgeCheckpointSettingsPage } from "./KnowledgeBackupSection";
export { CodeBackupSection, CodeBackupSettingsPage } from "./CodeBackupSection";
export { AgentArchiveSection, AgentArchiveSection as AgentArchiveSettingsSection } from "./AgentArchiveSection";
