import {
  agentArchiveSettingsSchema,
  agentRuntimeSettingsSchema,
  codeBackupSettingsSchema,
  githubIntegrationSchema,
  jsonSourceSchema,
  jsonSourceVersionsResponseSchema,
  repositorySettingsSchema,
  savedResponseSchema,
  removedResponseSchema,
  type AgentRuntimeSettings,
  type AgentRuntimeSettingsUpdate,
  type AgentArchiveSettings,
  type AgentArchiveSettingsUpdate,
  type CodeBackupSettings,
  type CodeBackupSettingsUpdate,
  type GitHubIntegration,
  type JsonSource,
  type JsonSourceVersionsResponse,
  type RepositorySettings,
  type RepositorySettingsUpdate,
  knowledgeCheckpointSettingsSchema,
  knowledgeCheckpointSettingsUpdateSchema,
  type KnowledgeCheckpointSettings,
  type KnowledgeCheckpointSettingsUpdate,
} from "@loongboard/contracts";

export type { AgentArchiveSettings, AgentArchiveSettingsUpdate, AgentRuntimeSettings, AgentRuntimeSettingsUpdate, CodeBackupSettings, CodeBackupSettingsUpdate, GitHubIntegration, JsonSource, KnowledgeCheckpointSettings, KnowledgeCheckpointSettingsUpdate, RepositorySettings } from "@loongboard/contracts";

async function json<T>(path: string, schema: { parse(value: unknown): T }, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error?: { message?: unknown } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(`${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${detail}`);
  }
  return schema.parse(body);
}

export function fetchRepositorySettings(repositoryId: string): Promise<RepositorySettings> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/settings`, repositorySettingsSchema);
}

export function updateRepositorySettings(repositoryId: string, patch: RepositorySettingsUpdate): Promise<RepositorySettings> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/settings`, repositorySettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
}

export function cleanupRepositoryWorktrees(repositoryId: string): Promise<RepositorySettings> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/settings/worktrees/cleanup`, repositorySettingsSchema, { method: "POST" });
}

export function fetchGitHubIntegration(): Promise<GitHubIntegration> {
  return json("/api/settings/integrations/github", githubIntegrationSchema);
}

export function verifyGitHubIntegration(): Promise<GitHubIntegration> {
  return json("/api/settings/integrations/github/verify", githubIntegrationSchema, { method: "POST" });
}

export function saveGitHubToken(token: string): Promise<GitHubIntegration> {
  return json("/api/settings/integrations/github", githubIntegrationSchema, { method: "PUT", body: JSON.stringify({ token }) });
}

export function removeGitHubToken(): Promise<{ removed: true }> {
  return json("/api/settings/integrations/github", removedResponseSchema, { method: "DELETE" });
}

export function fetchAgentRuntimeSettings(): Promise<AgentRuntimeSettings> {
  return json("/api/settings/agent", agentRuntimeSettingsSchema);
}

export function updateAgentRuntimeSettings(patch: AgentRuntimeSettingsUpdate): Promise<AgentRuntimeSettings> {
  return json("/api/settings/agent", agentRuntimeSettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
}

export function saveProviderSecret(provider: string, secret: string): Promise<{ saved: true }> {
  return json("/api/settings/agent/providers", savedResponseSchema, { method: "PUT", body: JSON.stringify({ provider, secret }) });
}

export function fetchDomainSource(repositoryId: string): Promise<JsonSource> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/source`, jsonSourceSchema);
}

export function saveDomainSource(repositoryId: string, content: string): Promise<JsonSource> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/source`, jsonSourceSchema, { method: "PUT", body: JSON.stringify({ content }) });
}

export function fetchDomainSourceVersions(repositoryId: string): Promise<JsonSourceVersionsResponse> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/source/versions`, jsonSourceVersionsResponseSchema);
}

export function restoreDomainSourceVersion(repositoryId: string, versionId: string): Promise<JsonSource> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/source/versions/${encodeURIComponent(versionId)}/restore`, jsonSourceSchema, { method: "POST" });
}

export function fetchDomainPrompt(repositoryId: string): Promise<JsonSource> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/prompt`, jsonSourceSchema);
}

export function saveDomainPrompt(repositoryId: string, content: string): Promise<JsonSource> {
  return json(`/api/repositories/${encodeURIComponent(repositoryId)}/domains/prompt`, jsonSourceSchema, { method: "PUT", body: JSON.stringify({ content }) });
}

export function fetchKnowledgeCheckpointSettings(): Promise<KnowledgeCheckpointSettings> {
  return json("/api/settings/knowledge-checkpoint", knowledgeCheckpointSettingsSchema);
}

export function fetchCodeBackupSettings(): Promise<CodeBackupSettings> {
  return json("/api/settings/code-backup", codeBackupSettingsSchema);
}

export function updateCodeBackupSettings(patch: CodeBackupSettingsUpdate): Promise<CodeBackupSettings> {
  return json("/api/settings/code-backup", codeBackupSettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
}

export function runCodeBackupCheckpoint(): Promise<{ accepted: true }> {
  return json("/api/settings/code-backup/checkpoint", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}

export function pushCodeBackup(): Promise<{ accepted: true }> {
  return json("/api/settings/code-backup/push", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}

export function fetchAgentArchiveSettings(): Promise<AgentArchiveSettings> {
  return json("/api/settings/agent-archive", agentArchiveSettingsSchema);
}

export function updateAgentArchiveSettings(patch: AgentArchiveSettingsUpdate): Promise<AgentArchiveSettings> {
  return json("/api/settings/agent-archive", agentArchiveSettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
}

export function runAgentArchiveExport(): Promise<{ accepted: true }> {
  return json("/api/settings/agent-archive/export", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}

export function pushAgentArchive(): Promise<{ accepted: true }> {
  return json("/api/settings/agent-archive/push", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}

export function updateKnowledgeCheckpointSettings(patch: KnowledgeCheckpointSettingsUpdate): Promise<KnowledgeCheckpointSettings> {
  return json("/api/settings/knowledge-checkpoint", knowledgeCheckpointSettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
}

export function runKnowledgeCheckpoint(): Promise<{ accepted: true }> {
  return json("/api/settings/knowledge-checkpoint/run", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}

export function pushKnowledgeCheckpoint(): Promise<{ accepted: true }> {
  return json("/api/settings/knowledge-checkpoint/push", savedResponseSchema, { method: "POST" }).then(() => ({ accepted: true as const }));
}
