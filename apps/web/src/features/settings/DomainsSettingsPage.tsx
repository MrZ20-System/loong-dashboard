import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DomainRule } from "@loongboard/contracts";
import { useDomains, useRepositories } from "../../app/hooks";
import {
  createDomainRule,
  deleteDomainRule,
  updateDomainRule,
} from "../../domains-client";
import {
  fetchDomainPrompt,
  fetchDomainSource,
  fetchDomainSourceVersions,
  restoreDomainSourceVersion,
  saveDomainPrompt,
  saveDomainSource,
} from "../../settings-client";
import { AgentChatPanel } from "../../agent-chat";
import { ensureAgentSession, sendAgentMessage } from "../../agent-chat-client";
import { useAgentSessionSelection } from "../agent/agent-session-context";

const defaultDomainColor = "#5b8def";

type DomainFormState = {
  name: string;
  color: string;
  include: string;
  exclude: string;
  enabled: boolean;
};

const emptyDomainForm: DomainFormState = {
  name: "",
  color: defaultDomainColor,
  include: "",
  exclude: "",
  enabled: true,
};

function ruleToFormState(rule: DomainRule): DomainFormState {
  return {
    name: rule.name,
    color: rule.color,
    include: rule.includePatterns.join("\n"),
    exclude: rule.excludePatterns.join("\n"),
    enabled: rule.enabled,
  };
}

function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function DomainsSettingsPage() {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const repositories = useRepositories();
  const repositoryId =
    searchParams.get("repository") ?? repositories.data?.items[0]?.id ?? "";
  const domains = useDomains(repositoryId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DomainFormState>(emptyDomainForm);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<"rendered" | "json" | "agent">("rendered");
  const [jsonText, setJsonText] = useState("");
  const [promptText, setPromptText] = useState("");
  const domainScope = useMemo(() => ({ kind: "domain" as const, repositoryId, domainId: "domains" }), [repositoryId]);
  const domainSelection = useAgentSessionSelection(JSON.stringify(domainScope));
  const source = useQuery({ queryKey: ["domain-source", repositoryId], enabled: repositoryId.length > 0 && (view === "json" || view === "agent"), queryFn: () => fetchDomainSource(repositoryId), refetchInterval: view === "agent" && domainSelection.sessionId ? 5_000 : false });
  const sourceVersions = useQuery({ queryKey: ["domain-source-versions", repositoryId], enabled: repositoryId.length > 0 && view === "json", queryFn: () => fetchDomainSourceVersions(repositoryId) });
  const prompt = useQuery({ queryKey: ["domain-prompt", repositoryId], enabled: repositoryId.length > 0 && view === "agent", queryFn: () => fetchDomainPrompt(repositoryId) });
  const rules = domains.data?.items ?? [];
  const reclassification = domains.data?.reclassification;

  const startEdit = (rule: DomainRule) => {
    setEditingId(rule.id);
    setForm(ruleToFormState(rule));
    setMessage(null);
  };
  const resetForm = () => {
    setEditingId(null);
    setForm(emptyDomainForm);
  };
  const submit = useMutation({
    mutationFn: () => {
      const includePatterns = parsePatterns(form.include);
      const excludePatterns = parsePatterns(form.exclude);
      if (form.name.trim().length === 0) throw new Error("Rule name is required.");
      if (includePatterns.length === 0)
        throw new Error("At least one include pattern is required.");
      const body = {
        name: form.name,
        color: form.color,
        includePatterns,
        excludePatterns,
        enabled: form.enabled,
      };
      return editingId === null
        ? createDomainRule(repositoryId, body)
        : updateDomainRule(repositoryId, editingId, body);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["domains", repositoryId] });
      setMessage(editingId === null ? "Rule created." : "Rule updated.");
      resetForm();
    },
    onError: (error: Error) => setMessage(`Save failed: ${error.message}`),
  });
  const remove = useMutation({
    mutationFn: (rule: DomainRule) => deleteDomainRule(repositoryId, rule.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["domains", repositoryId] });
      if (editingId !== null) resetForm();
    },
    onError: (error: Error) => setMessage(`Delete failed: ${error.message}`),
  });
  const selectRepository = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("repository", id);
    setSearchParams(next);
    resetForm();
    setMessage(null);
  };
  const saveJson = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try { parsed = JSON.parse(jsonText) as unknown; } catch { throw new Error("Domain JSON is invalid. Fix the syntax before saving."); }
      return saveDomainSource(repositoryId, JSON.stringify(parsed, null, 2));
    },
    onSuccess: (saved) => { setJsonText(saved.content); setMessage("Domain JSON saved and rendered data will refresh."); void client.invalidateQueries({ queryKey: ["domains", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] }); },
    onError: (error: Error) => setMessage(`Save failed: ${error.message}`),
  });
  const restoreJson = useMutation({
    mutationFn: (versionId: string) => restoreDomainSourceVersion(repositoryId, versionId),
    onSuccess: (saved) => { setJsonText(saved.content); setMessage("Domain JSON version restored."); void client.invalidateQueries({ queryKey: ["domains", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source-versions", repositoryId] }); },
    onError: (error: Error) => setMessage(`Restore failed: ${error.message}`),
  });
  const savePrompt = useMutation({ mutationFn: () => saveDomainPrompt(repositoryId, promptText), onSuccess: (saved) => { setPromptText(saved.content); setMessage("Update prompt saved."); void client.invalidateQueries({ queryKey: ["domain-prompt", repositoryId] }); }, onError: (error: Error) => setMessage(`Save failed: ${error.message}`) });
  const usePrompt = useMutation({
    mutationFn: async () => {
      if (repositoryId.length === 0) throw new Error("Choose a repository before opening Agent.");
      const saved = await saveDomainPrompt(repositoryId, promptText);
      let sessionId = domainSelection.sessionId;
      if (sessionId === undefined) {
        const view = await ensureAgentSession(domainScope);
        sessionId = view.session.id;
        domainSelection.setSessionId(sessionId);
      }
      const repository = repositories.data?.items.find((item) => item.id === repositoryId);
      const filePath = source.data?.path ?? `domains/${repositoryId}.json`;
      const context = `Domain update context\nRepository: ${repository?.displayName ?? repositoryId} (${repositoryId})\nLocal repository path: ${repository?.localPath ?? "available from the workspace"}\nDomain JSON file: ${filePath}\n\nSaved update prompt:\n`;
      await sendAgentMessage(sessionId, `${context}${saved.content}`);
      return { sessionId, content: saved.content };
    },
    onSuccess: ({ sessionId, content }) => { setPromptText(content); setMessage("Prompt sent to the persistent Agent conversation."); void client.invalidateQueries({ queryKey: ["domain-prompt", repositoryId] }); void client.invalidateQueries({ queryKey: ["agent-messages", sessionId] }); },
    onError: (error: Error) => setMessage(`Agent update failed: ${error.message}`),
  });
  useEffect(() => { if (source.data !== undefined) setJsonText(source.data.content); }, [source.data]);
  useEffect(() => { if (prompt.data !== undefined) setPromptText(prompt.data.content); }, [prompt.data]);
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError)
    return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (repositories.data.items.length === 0)
    return <p role="status">No configured repositories.</p>;
  return (
    <section className="domain-settings plain-page" aria-labelledby="domains-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuration</p>
          <h2 id="domains-heading">Domain rules</h2>
        </div>
        <Link className="text-link" to="/">
          Change repository
        </Link>
      </div>
      <div className="domain-settings-toolbar">
        <label className="repository-selector">
          Repository
          <select
            aria-label="Rule repository"
            value={repositoryId}
            onChange={(event) => selectRepository(event.target.value)}
          >
            {repositories.data.items.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.displayName} ({repository.githubOwner}/{repository.githubName})
              </option>
            ))}
          </select>
        </label>
        {reclassification?.running && (
          <p role="status" className="reclassify-hint">
            重新分类中… (pending: {reclassification.pendingCount ?? 0})
          </p>
        )}
      </div>
      <div className="domain-view-tabs" role="tablist" aria-label="Domain views">
        {([ ["rendered", "Rendered"], ["json", "JSON source"], ["agent", "Agent update"] ] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "domain-view-tab active" : "domain-view-tab"} onClick={() => { setView(key); setMessage(null); }}>{label}</button>)}
      </div>
      {view === "json" && <section className="domain-source-editor" aria-label="Domain JSON source"><div className="domain-source-editor__header"><div><h3>JSON source</h3><p>Edit the file directly. Save validates and pretty formats JSON.</p></div><span>{source.data?.path ?? "Loading source…"}{source.data?.version !== undefined && source.data.version !== null ? ` · v${source.data.version}` : ""}{source.data?.hash ? ` · ${source.data.hash.slice(0, 10)}` : ""}</span></div>{source.isError && <p role="alert">{source.error.message}</p>}{source.data?.parseError && <p role="alert">This source file is readable but invalid: {source.data.parseError}. Repair it below; the last valid rendered projection remains active.</p>}<textarea aria-label="Domain JSON" value={jsonText} onChange={(event) => setJsonText(event.target.value)} rows={22} placeholder="{\n  &quot;domains&quot;: []\n}" /><div className="domain-form-actions"><button type="button" className="button-primary" onClick={() => saveJson.mutate()} disabled={saveJson.isPending || source.isPending}>{saveJson.isPending ? "Saving…" : "Save JSON"}</button><button type="button" onClick={() => setJsonText(source.data?.content ?? "")}>Reload</button></div><details className="domain-version-history"><summary>Version history</summary>{sourceVersions.isPending && <p role="status">Loading versions…</p>}{sourceVersions.isError && <p role="alert">{sourceVersions.error.message}</p>}{sourceVersions.data?.items.length === 0 && <p role="status">No saved versions.</p>}<ul>{sourceVersions.data?.items.slice().reverse().map((version) => <li key={version.id}><span>v{version.version} · {version.source} · {new Date(version.createdAt).toLocaleString()}</span><button type="button" onClick={() => { if (window.confirm(`Restore domain JSON version ${version.version}?`)) restoreJson.mutate(version.id); }} disabled={restoreJson.isPending}>Restore</button></li>)}</ul></details>{message && <p role={message.startsWith("Save failed") || message.startsWith("Restore failed") ? "alert" : "status"}>{message}</p>}</section>}
      {view === "agent" && <section className="domain-agent-editor" aria-label="Agent domain update"><div className="domain-source-editor__header"><div><h3>Agent update</h3><p>Save the prompt and send it to a persistent conversation. The Agent can edit this JSON file and you can continue the same session.</p></div><span>{prompt.data?.path ?? "Loading prompt…"}{prompt.data?.version !== undefined && prompt.data.version !== null ? ` · v${prompt.data.version}` : ""}{prompt.data?.hash ? ` · ${prompt.data.hash.slice(0, 10)}` : ""}</span></div>{prompt.isError && <p role="alert">{prompt.error.message}</p>}<div className="domain-agent-layout"><div className="domain-agent-editor__controls"><textarea aria-label="Domain update prompt" value={promptText} onChange={(event) => setPromptText(event.target.value)} rows={12} placeholder="Describe how the Agent should update domains…" /><div className="domain-form-actions"><button type="button" className="button-primary" onClick={() => savePrompt.mutate()} disabled={savePrompt.isPending || prompt.isPending}>Save prompt</button><button type="button" className="button-primary" onClick={() => usePrompt.mutate()} disabled={usePrompt.isPending || prompt.isPending}>{usePrompt.isPending ? "Opening Agent…" : domainSelection.sessionId ? "Send prompt to Agent" : "Use prompt in Agent"}</button><Link className="button-link" to={`/agent?repository=${encodeURIComponent(repositoryId)}&origin=domain${domainSelection.sessionId ? `&session=${encodeURIComponent(domainSelection.sessionId)}` : ""}`}>Open full conversation</Link></div>{message && <p role={message.startsWith("Save failed") || message.startsWith("Agent update failed") ? "alert" : "status"}>{message}</p>}</div><div className="domain-agent-preview"><h4>Current JSON file</h4>{source.isError && <p role="alert">{source.error.message}</p>}<pre>{source.data?.content ?? "Loading source…"}</pre><button type="button" onClick={() => void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] })}>Refresh preview</button></div>{domainSelection.sessionId && <AgentChatPanel scope={domainScope} initialSessionId={domainSelection.sessionId} heading="Domain Agent" panelId="domain-agent-chat" showCollapseControl={false} />}</div></section>}
      {view === "rendered" && <>
      <div className="domain-settings-layout">
        <div className="domain-rules" aria-label="Domain rules">
          {rules.length === 0 && (
            <p role="status">No domain rules yet. Create the first rule on the right.</p>
          )}
          {rules.map((rule) => (
            <article
              key={rule.id}
              className={rule.enabled ? "domain-rule" : "domain-rule disabled"}
            >
              <header>
                <span className="domain-chip" style={{ backgroundColor: rule.color }}>
                  {rule.name}
                </span>
                <span className="domain-rule-meta">
                  #{rule.position}
                  {rule.enabled ? "" : " · disabled"}
                </span>
              </header>
              <p>
                <strong>Include:</strong>{" "}
                <code>{rule.includePatterns.join(", ")}</code>
              </p>
              {rule.excludePatterns.length > 0 && (
                <p>
                  <strong>Exclude:</strong>{" "}
                  <code>{rule.excludePatterns.join(", ")}</code>
                </p>
              )}
              <div className="domain-rule-actions">
                <button type="button" onClick={() => startEdit(rule)}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete domain rule "${rule.name}"?`))
                      remove.mutate(rule);
                  }}
                  disabled={remove.isPending}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
        <form
          className="domain-form"
          aria-label={editingId === null ? "Create domain rule" : "Edit domain rule"}
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <h3>{editingId === null ? "New rule" : "Edit rule"}</h3>
          <label>
            Name
            <input
              aria-label="Rule name"
              value={form.name}
              placeholder="Documentation"
              maxLength={40}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label>
            Color
            <input
              aria-label="Rule color"
              type="color"
              value={form.color}
              onChange={(event) => setForm({ ...form, color: event.target.value })}
            />
          </label>
          <label>
            Include patterns (one pattern per line)
            <textarea
              aria-label="Include patterns"
              rows={4}
              value={form.include}
              placeholder={"docs/**\nREADME.md"}
              onChange={(event) => setForm({ ...form, include: event.target.value })}
            />
          </label>
          <label>
            Exclude patterns (one pattern per line)
            <textarea
              aria-label="Exclude patterns"
              rows={3}
              value={form.exclude}
              placeholder={"docs/generated/**\n**/*.snap"}
              onChange={(event) => setForm({ ...form, exclude: event.target.value })}
            />
          </label>
          <label className="checkbox">
            <input
              aria-label="Rule enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />
            Enabled
          </label>
          <div className="domain-form-actions">
            <button type="submit" disabled={submit.isPending}>
              {editingId === null ? "Create rule" : "Save changes"}
            </button>
            {editingId !== null && (
              <button type="button" onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>
          {message && (
            <p
              role={
                message.startsWith("Save") || message.startsWith("Delete")
                  ? "alert"
                  : "status"
              }
            >
              {message}
            </p>
          )}
        </form>
      </div>
      </>}
    </section>
  );
}
