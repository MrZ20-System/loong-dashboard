import { Link } from "react-router-dom";
import { useI18n } from "../../i18n";

export function SettingsControlCenter() {
  const { t } = useI18n();
  return (
    <section className="settings-control-center" aria-labelledby="settings-control-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t({ en: "Control center", "zh-CN": "控制中心" })}</p>
          <h2 id="settings-control-heading">{t({ en: "Workspace settings", "zh-CN": "工作区设置" })}</h2>
          <p className="page-subtitle">{t({ en: "Manage repositories, credentials, runtime defaults, files and scheduled work.", "zh-CN": "管理仓库、凭据、运行时默认值、文件和计划任务。" })}</p>
        </div>
      </div>
      <div className="settings-control-grid">
        <article className="settings-control-tile"><span className="settings-tile-icon">↻</span><h3>{t({ en: "Repositories", "zh-CN": "仓库" })}</h3><p>{t({ en: "Sync status and automatic frequency for each configured repository.", "zh-CN": "查看每个已配置仓库的同步状态和自动频率。" })}</p><Link to="/settings/repositories">{t({ en: "Manage repositories", "zh-CN": "管理仓库" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⌁</span><h3>{t({ en: "Integrations", "zh-CN": "集成" })}</h3><p>{t({ en: "Verify GitHub access and quota without exposing secrets.", "zh-CN": "验证 GitHub 访问和配额，不暴露密钥。" })}</p><Link to="/settings/integrations">{t({ en: "Manage integrations", "zh-CN": "管理集成" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">✦</span><h3>{t({ en: "Agent", "zh-CN": "智能代理" })}</h3><p>{t({ en: "Runtime health, dynamic defaults and idle retention.", "zh-CN": "运行时健康状态、动态默认值和空闲保留。" })}</p><Link to="/settings/agent">{t({ en: "Configure Agent", "zh-CN": "配置智能代理" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">◇</span><h3>{t({ en: "Domains", "zh-CN": "领域" })}</h3><p>{t({ en: "Edit rendered rules, JSON source and update prompts.", "zh-CN": "编辑渲染规则、JSON 源文件和更新提示词。" })}</p><Link to="/settings/domains">{t({ en: "Open Domains", "zh-CN": "打开领域" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">◷</span><h3>{t({ en: "Schedules", "zh-CN": "计划任务" })}</h3><p>{t({ en: "Review Agent and system schedules and run history.", "zh-CN": "查看智能代理和系统计划任务及运行历史。" })}</p><Link to="/settings/schedules">{t({ en: "Open Schedules", "zh-CN": "打开计划任务" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">♥</span><h3>{t({ en: "Health", "zh-CN": "健康状态" })}</h3><p>{t({ en: "Check the API and runtime boundary.", "zh-CN": "检查 API 和运行时边界。" })}</p><Link to="/settings/health">{t({ en: "Open Health", "zh-CN": "打开健康状态" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">✓</span><h3>{t({ en: "Knowledge checkpoint", "zh-CN": "知识库检查点" })}</h3><p>{t({ en: "Configure the existing Knowledge commit and push behavior.", "zh-CN": "配置现有知识库提交和推送行为。" })}</p><Link to="/settings/checkpoint">{t({ en: "Manage checkpoint", "zh-CN": "管理检查点" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⇧</span><h3>{t({ en: "Code backup", "zh-CN": "代码备份" })}</h3><p>{t({ en: "Protect the LoongBoard source repository with separate checkpoint and push cadence.", "zh-CN": "使用独立的检查点和推送频率保护 LoongBoard 源代码仓库。" })}</p><Link to="/settings/code-backup">{t({ en: "Manage code backup", "zh-CN": "管理代码备份" })}</Link></article>
        <article className="settings-control-tile"><span className="settings-tile-icon">⌑</span><h3>{t({ en: "Security", "zh-CN": "安全" })}</h3><p>{t({ en: "Enable or change the local password lock for Web/API access.", "zh-CN": "启用或更改 Web/API 访问的本地密码锁。" })}</p><Link to="/settings/security">{t({ en: "Manage password lock", "zh-CN": "管理密码锁" })}</Link></article>
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
