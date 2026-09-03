import { desc, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    displayName: text("display_name").notNull(),
    githubOwner: text("github_owner").notNull(),
    githubName: text("github_name").notNull(),
    localPath: text("local_path").notNull(),
    remoteName: text("remote_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    worktreeSlots: integer("worktree_slots").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("repositories_github_owner_name_unique").on(
      table.githubOwner,
      table.githubName,
    ),
    check("repositories_worktree_slots_check", sql`${table.worktreeSlots} >= 0`),
    check("repositories_enabled_check", sql`${table.enabled} IN (0, 1)`),
  ],
);

export const repositorySyncState = sqliteTable(
  "repository_sync_state",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind", {
      enum: ["pull_request", "issue"],
    }).notNull(),
    watermarkUpdatedAt: text("watermark_updated_at"),
    lastAttemptAt: text("last_attempt_at"),
    lastSuccessAt: text("last_success_at"),
    status: text("status", { enum: ["idle", "running", "failed"] }).notNull(),
    lastError: text("last_error"),
    rateLimitRemaining: integer("rate_limit_remaining"),
    rateLimitResetAt: text("rate_limit_reset_at"),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.entityKind] }),
    check(
      "repository_sync_state_entity_kind_check",
      sql`${table.entityKind} IN ('pull_request', 'issue')`,
    ),
    check(
      "repository_sync_state_status_check",
      sql`${table.status} IN ('idle', 'running', 'failed')`,
    ),
    check(
      "repository_sync_state_rate_limit_remaining_check",
      sql`${table.rateLimitRemaining} IS NULL OR ${table.rateLimitRemaining} >= 0`,
    ),
  ],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    authorLogin: text("author_login"),
    stateRaw: text("state_raw").notNull(),
    status: text("status", {
      enum: ["draft", "open", "closed", "merged"],
    }).notNull(),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    mergedAt: text("merged_at"),
    baseRefName: text("base_ref_name").notNull(),
    headRefName: text("head_ref_name").notNull(),
    headSha: text("head_sha").notNull(),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
    changedFilesCount: integer("changed_files_count").notNull(),
    detailBody: text("detail_body"),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.number] }),
    unique("pull_requests_repository_node_unique").on(
      table.repositoryId,
      table.nodeId,
    ),
    index("pull_requests_updated_number_idx").on(
      table.repositoryId,
      desc(table.updatedAt),
      desc(table.number),
    ),
    index("pull_requests_status_updated_idx").on(
      table.repositoryId,
      table.status,
      desc(table.updatedAt),
    ),
    index("pull_requests_status_updated_number_idx").on(
      table.repositoryId,
      table.status,
      desc(table.updatedAt),
      desc(table.number),
    ),
    check("pull_requests_number_check", sql`${table.number} > 0`),
    check(
      "pull_requests_status_check",
      sql`${table.status} IN ('draft', 'open', 'closed', 'merged')`,
    ),
    check("pull_requests_is_draft_check", sql`${table.isDraft} IN (0, 1)`),
    check("pull_requests_additions_check", sql`${table.additions} >= 0`),
    check("pull_requests_deletions_check", sql`${table.deletions} >= 0`),
    check(
      "pull_requests_changed_files_count_check",
      sql`${table.changedFilesCount} >= 0`,
    ),
  ],
);

export const pullRequestFiles = sqliteTable(
  "pull_request_files",
  {
    repositoryId: text("repository_id").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    path: text("path").notNull(),
    previousPath: text("previous_path"),
    changeType: text("change_type").notNull(),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.repositoryId, table.prNumber, table.headSha, table.path],
    }),
    foreignKey({
      columns: [table.repositoryId, table.prNumber],
      foreignColumns: [pullRequests.repositoryId, pullRequests.number],
    }).onDelete("cascade"),
    index("pull_request_files_head_idx").on(
      table.repositoryId,
      table.prNumber,
      table.headSha,
    ),
    check("pull_request_files_pr_number_check", sql`${table.prNumber} > 0`),
    check("pull_request_files_additions_check", sql`${table.additions} >= 0`),
    check("pull_request_files_deletions_check", sql`${table.deletions} >= 0`),
  ],
);

export const domainRules = sqliteTable(
  "domain_rules",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    includePatternsJson: text("include_patterns_json").notNull(),
    excludePatternsJson: text("exclude_patterns_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("domain_rules_repository_id_unique").on(table.repositoryId, table.id),
    unique("domain_rules_repository_name_unique").on(
      table.repositoryId,
      table.name,
    ),
    check("domain_rules_position_check", sql`${table.position} >= 0`),
    check("domain_rules_enabled_check", sql`${table.enabled} IN (0, 1)`),
  ],
);

export const pullRequestDomains = sqliteTable(
  "pull_request_domains",
  {
    repositoryId: text("repository_id").notNull(),
    prNumber: integer("pr_number").notNull(),
    domainRuleId: text("domain_rule_id").notNull(),
    classificationKey: text("classification_key").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.repositoryId, table.prNumber, table.domainRuleId],
    }),
    foreignKey({
      columns: [table.repositoryId, table.prNumber],
      foreignColumns: [pullRequests.repositoryId, pullRequests.number],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.repositoryId, table.domainRuleId],
      foreignColumns: [domainRules.repositoryId, domainRules.id],
    }).onDelete("cascade"),
    index("pull_request_domains_filter_idx").on(
      table.repositoryId,
      table.domainRuleId,
      table.prNumber,
    ),
    check("pull_request_domains_pr_number_check", sql`${table.prNumber} > 0`),
  ],
);

export const issues = sqliteTable(
  "issues",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    authorLogin: text("author_login"),
    state: text("state").notNull(),
    commentsCount: integer("comments_count").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    detailBody: text("detail_body"),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.number] }),
    unique("issues_repository_node_unique").on(table.repositoryId, table.nodeId),
    index("issues_updated_number_idx").on(
      table.repositoryId,
      desc(table.updatedAt),
      desc(table.number),
    ),
    index("issues_state_updated_number_idx").on(
      table.repositoryId,
      table.state,
      desc(table.updatedAt),
      desc(table.number),
    ),
    check("issues_number_check", sql`${table.number} > 0`),
    check("issues_comments_count_check", sql`${table.commentsCount} >= 0`),
  ],
);

export const knowledgeDocuments = sqliteTable("knowledge_documents", {
  id: text("id").primaryKey(),
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  defaultSessionId: text("default_session_id").references(
    (): AnySQLiteColumn => agentSessions.id,
    { onDelete: "set null" },
  ),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type", {
      enum: ["pr", "issue", "knowledge", "general"],
    }).notNull(),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    prNumber: integer("pr_number"),
    issueNumber: integer("issue_number"),
    targetSha: text("target_sha"),
    knowledgeDocumentId: text("knowledge_document_id").references(
      (): AnySQLiteColumn => knowledgeDocuments.id,
      { onDelete: "set null" },
    ),
    dshSessionId: text("dsh_session_id"),
    dshHomePath: text("dsh_home_path").notNull(),
    workspacePath: text("workspace_path").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.repositoryId, table.prNumber],
      foreignColumns: [pullRequests.repositoryId, pullRequests.number],
    }).onDelete("set null"),
    foreignKey({
      columns: [table.repositoryId, table.issueNumber],
      foreignColumns: [issues.repositoryId, issues.number],
    }).onDelete("set null"),
    check(
      "agent_sessions_scope_type_check",
      sql`${table.scopeType} IN ('pr', 'issue', 'knowledge', 'general')`,
    ),
    check(
      "agent_sessions_repository_scope_check",
      sql`(${table.prNumber} IS NULL AND ${table.issueNumber} IS NULL AND ${table.targetSha} IS NULL) OR ${table.repositoryId} IS NOT NULL`,
    ),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role", {
      enum: ["user", "assistant", "tool", "system-status"],
    }).notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("agent_messages_session_sequence_unique").on(
      table.sessionId,
      table.sequence,
    ),
    index("agent_messages_session_idx").on(table.sessionId, table.sequence),
    check("agent_messages_sequence_check", sql`${table.sequence} >= 0`),
    check(
      "agent_messages_role_check",
      sql`${table.role} IN ('user', 'assistant', 'tool', 'system-status')`,
    ),
  ],
);

export const worktreeSlots = sqliteTable(
  "worktree_slots",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    slotName: text("slot_name").notNull(),
    path: text("path").notNull().unique(),
    prNumber: integer("pr_number"),
    targetSha: text("target_sha"),
    busySessionId: text("busy_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    unique("worktree_slots_repository_name_unique").on(
      table.repositoryId,
      table.slotName,
    ),
    foreignKey({
      columns: [table.repositoryId, table.prNumber],
      foreignColumns: [pullRequests.repositoryId, pullRequests.number],
    }).onDelete("set null"),
    check(
      "worktree_slots_target_sha_check",
      sql`${table.prNumber} IS NOT NULL OR ${table.targetSha} IS NULL`,
    ),
  ],
);

export const documentVersions = sqliteTable(
  "document_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(),
    source: text("source", {
      enum: ["manual", "agent", "external", "restore"],
    }).notNull(),
    agentRunId: text("agent_run_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("document_versions_document_number_unique").on(
      table.documentId,
      table.versionNumber,
    ),
    index("document_versions_document_idx").on(
      table.documentId,
      desc(table.versionNumber),
    ),
    check(
      "document_versions_version_number_check",
      sql`${table.versionNumber} > 0`,
    ),
    check(
      "document_versions_source_check",
      sql`${table.source} IN ('manual', 'agent', 'external', 'restore')`,
    ),
  ],
);

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull(),
    prompt: text("prompt").notNull(),
    workspacePath: text("workspace_path").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("scheduled_tasks_next_run_idx").on(table.enabled, table.nextRunAt),
    check("scheduled_tasks_enabled_check", sql`${table.enabled} IN (0, 1)`),
  ],
);

export const scheduledTaskRuns = sqliteTable(
  "scheduled_task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    scheduledFor: text("scheduled_for").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    status: text("status", {
      enum: ["running", "completed", "failed", "skipped"],
    }).notNull(),
    agentSessionId: text("agent_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    error: text("error"),
  },
  (table) => [
    index("scheduled_task_runs_task_idx").on(
      table.taskId,
      desc(table.scheduledFor),
    ),
    check(
      "scheduled_task_runs_status_check",
      sql`${table.status} IN ('running', 'completed', 'failed', 'skipped')`,
    ),
  ],
);

export const schema = {
  agentMessages,
  agentSessions,
  documentVersions,
  domainRules,
  issues,
  knowledgeDocuments,
  pullRequestDomains,
  pullRequestFiles,
  pullRequests,
  repositories,
  repositorySyncState,
  scheduledTaskRuns,
  scheduledTasks,
  worktreeSlots,
};
