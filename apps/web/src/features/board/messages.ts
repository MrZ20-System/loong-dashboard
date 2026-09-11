import { message } from "../../i18n";

export const boardMessages = {
  repository: message("Repository", "仓库"),
  loadingRepositories: message("Loading repositories…", "正在加载仓库…"),
  unableLoadRepositories: message(
    "Unable to load repositories: {detail}",
    "无法加载仓库：{detail}",
  ),
  noConfiguredRepositories: message("No configured repositories.", "没有已配置的仓库。"),
  configuredRepositories: message("Configured repositories", "已配置的仓库"),
  repositories: message("Repositories", "仓库"),
  repositoryOverview: message("Repository overview", "仓库概览"),
  localFirstWorkspace: message(
    "Local-first engineering workspace",
    "本地优先的工程工作区",
  ),
  clearView: message(
    "A clear view of your repositories and knowledge.",
    "清晰掌握你的仓库与知识。",
  ),
  lead: message(
    "LoongBoard brings local Git workspaces, durable Markdown knowledge, and coding-agent sessions together in one focused board.",
    "LoongBoard 将本地 Git 工作区、持久 Markdown 知识与编码 Agent 会话汇聚在一个专注的看板中。",
  ),
};
