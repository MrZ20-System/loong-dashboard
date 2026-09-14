import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DEFAULT_DOMAIN_UPDATE_PROMPT,
  domainColorSchema,
  type DomainRule,
} from "@loongboard/contracts";
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
import { SettingsSwitch } from "./SettingsSwitch";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";

const defaultDomainColor = "#5b8def";

type DomainFormState = {
  name: string;
  color: string;
  include: string;
  exclude: string;
  enabled: boolean;
};

type Feedback = { message: LocalizedMessage; values?: MessageValues; tone: "alert" | "status" };

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

function isDomainColor(value: string): boolean {
  return domainColorSchema.safeParse(value.trim()).success;
}

export function DomainsSettingsPage() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const repositories = useRepositories();
  const repositoryId =
    searchParams.get("repository") ?? repositories.data?.items[0]?.id ?? "";
  const domains = useDomains(repositoryId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DomainFormState>(emptyDomainForm);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const setMessage = (message: LocalizedMessage | null, values?: MessageValues, tone: "alert" | "status" = "status") => {
    setFeedback(message === null ? null : { message, values, tone });
  };
  const message = feedback === null ? null : t(feedback.message, feedback.values);
  const [view, setView] = useState<"rendered" | "json" | "agent">("rendered");
  const [jsonText, setJsonText] = useState("");
  const [promptText, setPromptText] = useState("");
  const [promptSavedText, setPromptSavedText] = useState("");
  const [promptEditing, setPromptEditing] = useState(false);
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
      const color = form.color.trim();
      if (form.name.trim().length === 0) throw new Error(t({ en: "Rule name is required.", "zh-CN": "规则名称为必填项。" }));
      if (includePatterns.length === 0)
        throw new Error(t({ en: "At least one include pattern is required.", "zh-CN": "至少需要一个包含模式。" }));
      if (!isDomainColor(color)) throw new Error(t({ en: "Color must be a six-digit hexadecimal value such as #5b8def.", "zh-CN": "颜色必须是六位十六进制值，例如 #5b8def。" }));
      const body = {
        name: form.name,
        color,
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
      setMessage(editingId === null ? { en: "Rule created.", "zh-CN": "规则已创建。" } : { en: "Rule updated.", "zh-CN": "规则已更新。" });
      resetForm();
    },
    onError: (error: Error) => setMessage({ en: "Save failed: {detail}", "zh-CN": "保存失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const remove = useMutation({
    mutationFn: (rule: DomainRule) => deleteDomainRule(repositoryId, rule.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["domains", repositoryId] });
      if (editingId !== null) resetForm();
      setMessage({ en: "Rule deleted.", "zh-CN": "规则已删除。" });
    },
    onError: (error: Error) => setMessage({ en: "Delete failed: {detail}", "zh-CN": "删除失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const selectRepository = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("repository", id);
    setSearchParams(next);
    resetForm();
    setPromptEditing(false);
    setPromptText("");
    setPromptSavedText("");
    setMessage(null);
  };
  const saveJson = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try { parsed = JSON.parse(jsonText) as unknown; } catch { throw new Error(t({ en: "Domain JSON is invalid. Fix the syntax before saving.", "zh-CN": "领域 JSON 无效。请修复语法后再保存。" })); }
      return saveDomainSource(repositoryId, JSON.stringify(parsed, null, 2));
    },
    onSuccess: (saved) => { setJsonText(saved.content); setMessage({ en: "Domain JSON saved and rendered data will refresh.", "zh-CN": "领域 JSON 已保存，渲染数据将刷新。" }); void client.invalidateQueries({ queryKey: ["domains", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] }); },
    onError: (error: Error) => setMessage({ en: "Save failed: {detail}", "zh-CN": "保存失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const restoreJson = useMutation({
    mutationFn: (versionId: string) => restoreDomainSourceVersion(repositoryId, versionId),
    onSuccess: (saved) => { setJsonText(saved.content); setMessage({ en: "Domain JSON version restored.", "zh-CN": "领域 JSON 版本已恢复。" }); void client.invalidateQueries({ queryKey: ["domains", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] }); void client.invalidateQueries({ queryKey: ["domain-source-versions", repositoryId] }); },
    onError: (error: Error) => setMessage({ en: "Restore failed: {detail}", "zh-CN": "恢复失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const savePrompt = useMutation({
    mutationFn: () => {
      if (promptText.trim().length === 0) throw new Error(t({ en: "The update prompt cannot be empty.", "zh-CN": "更新提示词不能为空。" }));
      return saveDomainPrompt(repositoryId, promptText);
    },
    onSuccess: (saved) => {
      setPromptText(saved.content);
      setPromptSavedText(saved.content);
      setPromptEditing(false);
      client.setQueryData(["domain-prompt", repositoryId], saved);
      setMessage({ en: "Update prompt saved.", "zh-CN": "更新提示词已保存。" });
      void client.invalidateQueries({ queryKey: ["domain-prompt", repositoryId] });
    },
    onError: (error: Error) => setMessage({ en: "Save failed: {detail}", "zh-CN": "保存失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const restorePrompt = useMutation({
    mutationFn: () => saveDomainPrompt(repositoryId, DEFAULT_DOMAIN_UPDATE_PROMPT),
    onSuccess: (saved) => {
      setPromptText(saved.content);
      setPromptSavedText(saved.content);
      setPromptEditing(false);
      client.setQueryData(["domain-prompt", repositoryId], saved);
      setMessage({ en: "Default update prompt restored and saved.", "zh-CN": "已还原并保存默认更新提示词。" });
      void client.invalidateQueries({ queryKey: ["domain-prompt", repositoryId] });
    },
    onError: (error: Error) => setMessage({ en: "Restore failed: {detail}", "zh-CN": "还原失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const usePrompt = useMutation({
    mutationFn: async () => {
      if (repositoryId.length === 0) throw new Error(t({ en: "Choose a repository before opening Agent.", "zh-CN": "打开智能代理前请选择仓库。" }));
      if (promptText !== promptSavedText) throw new Error(t({ en: "Save the prompt before sending it to Agent.", "zh-CN": "请先保存提示词，再发送给智能代理。" }));
      if (promptSavedText.trim().length === 0) throw new Error(t({ en: "The update prompt cannot be empty.", "zh-CN": "更新提示词不能为空。" }));
      let sessionId = domainSelection.sessionId;
      if (sessionId === undefined) {
        const view = await ensureAgentSession(domainScope);
        sessionId = view.session.id;
        domainSelection.setSessionId(sessionId);
      }
      const repository = repositories.data?.items.find((item) => item.id === repositoryId);
      const filePath = source.data?.path ?? `domains/${repositoryId}.json`;
      const context = `${t({ en: "Domain update context", "zh-CN": "领域更新上下文" })}\n${t({ en: "Repository:", "zh-CN": "仓库：" })} ${repository?.displayName ?? repositoryId} (${repositoryId})\n${t({ en: "Local repository path:", "zh-CN": "本地仓库路径：" })} ${repository?.localPath ?? t({ en: "available from the workspace", "zh-CN": "可从工作区获取" })}\n${t({ en: "Domain JSON file:", "zh-CN": "领域 JSON 文件：" })} ${filePath}\n\n${t({ en: "Saved update prompt:", "zh-CN": "已保存的更新提示词：" })}\n`;
      await sendAgentMessage(sessionId, `${context}${promptSavedText}`);
      return { sessionId };
    },
    onSuccess: ({ sessionId }) => { setMessage({ en: "Prompt sent to the persistent Agent conversation.", "zh-CN": "提示词已发送到持久智能代理对话。" }); void client.invalidateQueries({ queryKey: ["agent-messages", sessionId] }); },
    onError: (error: Error) => setMessage({ en: "Agent update failed: {detail}", "zh-CN": "智能代理更新失败：{detail}" }, { detail: error.message }, "alert"),
  });
  const promptIsDirty = promptText !== promptSavedText;
  useEffect(() => { if (source.data !== undefined) setJsonText(source.data.content); }, [source.data]);
  useEffect(() => {
    if (prompt.data !== undefined && !promptEditing) {
      setPromptText(prompt.data.content);
      setPromptSavedText(prompt.data.content);
    }
  }, [prompt.data, promptEditing]);
  if (repositories.isPending) return <p role="status">{t({ en: "Loading repositories…", "zh-CN": "正在加载仓库…" })}</p>;
  if (repositories.isError)
    return <p role="alert">{t({ en: "Unable to load repositories:", "zh-CN": "无法加载仓库：" })} {repositories.error.message}</p>;
  if (repositories.data.items.length === 0)
    return <p role="status">{t({ en: "No configured repositories.", "zh-CN": "没有已配置的仓库。" })}</p>;
  return (
    <section className="domain-settings plain-page" aria-labelledby="domains-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t({ en: "Configuration", "zh-CN": "配置" })}</p>
          <h2 id="domains-heading">{t({ en: "Domain rules", "zh-CN": "领域规则" })}</h2>
        </div>
        <Link className="text-link" to="/">
          {t({ en: "Change repository", "zh-CN": "切换仓库" })}
        </Link>
      </div>
      <div className="domain-settings-toolbar">
        <label className="repository-selector">
          {t({ en: "Repository", "zh-CN": "仓库" })}
          <select
            aria-label={t({ en: "Rule repository", "zh-CN": "规则仓库" })}
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
            {t({ en: "Reclassifying…", "zh-CN": "重新分类中…" })} ({t({ en: "pending", "zh-CN": "待处理" })}: {formatNumber(reclassification.pendingCount ?? 0)})
          </p>
        )}
      </div>
      <div className="domain-view-tabs" role="tablist" aria-label={t({ en: "Domain views", "zh-CN": "领域视图" })}>
        {([ ["rendered", { en: "Rendered", "zh-CN": "渲染结果" }], ["json", { en: "JSON source", "zh-CN": "JSON 源文件" }], ["agent", { en: "Agent update", "zh-CN": "智能代理更新" }] ] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "domain-view-tab active" : "domain-view-tab"} onClick={() => { setView(key); setMessage(null); }}>{t(label)}</button>)}
      </div>
      {view === "json" && <section className="domain-source-editor" aria-label={t({ en: "Domain JSON source", "zh-CN": "领域 JSON 源文件" })}><div className="domain-source-editor__header"><div><h3>{t({ en: "JSON source", "zh-CN": "JSON 源文件" })}</h3><p>{t({ en: "Edit the file directly. Save validates and pretty formats JSON.", "zh-CN": "直接编辑文件。保存时会校验并格式化 JSON。" })}</p></div><span>{source.data?.path ?? t({ en: "Loading source…", "zh-CN": "正在加载源文件…" })}{source.data?.version !== undefined && source.data.version !== null ? ` · v${formatNumber(source.data.version)}` : ""}{source.data?.hash ? ` · ${source.data.hash.slice(0, 10)}` : ""}</span></div>{source.isError && <p role="alert">{source.error.message}</p>}{source.data?.parseError && <p role="alert">{t({ en: "This source file is readable but invalid:", "zh-CN": "源文件可读取但无效：" })} {source.data.parseError}. {t({ en: "Repair it below; the last valid rendered projection remains active.", "zh-CN": "请在下方修复；上一次有效的渲染投影仍然生效。" })}</p>}<textarea aria-label={t({ en: "Domain JSON", "zh-CN": "领域 JSON" })} value={jsonText} onChange={(event) => setJsonText(event.target.value)} rows={22} placeholder="{\n  &quot;domains&quot;: []\n}" /><div className="domain-form-actions"><button type="button" className="button-primary" onClick={() => saveJson.mutate()} disabled={saveJson.isPending || source.isPending}>{saveJson.isPending ? t({ en: "Saving…", "zh-CN": "保存中…" }) : t({ en: "Save JSON", "zh-CN": "保存 JSON" })}</button><button type="button" onClick={() => setJsonText(source.data?.content ?? "")}>{t({ en: "Reload", "zh-CN": "重新加载" })}</button></div><details className="domain-version-history"><summary>{t({ en: "Version history", "zh-CN": "版本历史" })}</summary>{sourceVersions.isPending && <p role="status">{t({ en: "Loading versions…", "zh-CN": "正在加载版本…" })}</p>}{sourceVersions.isError && <p role="alert">{sourceVersions.error.message}</p>}{sourceVersions.data?.items.length === 0 && <p role="status">{t({ en: "No saved versions.", "zh-CN": "没有已保存的版本。" })}</p>}<ul>{sourceVersions.data?.items.slice().reverse().map((version) => <li key={version.id}><span>v{formatNumber(version.version)} · {version.source} · {formatDateTime(version.createdAt)}</span><button type="button" onClick={() => { if (window.confirm(t({ en: `Restore domain JSON version ${formatNumber(version.version)}?`, "zh-CN": `恢复领域 JSON 版本 ${formatNumber(version.version)}？` }))) restoreJson.mutate(version.id); }} disabled={restoreJson.isPending}>{t({ en: "Restore", "zh-CN": "恢复" })}</button></li>)}</ul></details>{message && <p role={feedback?.tone ?? "status"}>{message}</p>}</section>}
      {view === "agent" && <section className="domain-agent-editor" aria-label={t({ en: "Agent domain update", "zh-CN": "智能代理领域更新" })}><div className="domain-source-editor__header"><div><h3>{t({ en: "Agent update", "zh-CN": "智能代理更新" })}</h3><p>{t({ en: "Review the saved prompt, edit it when needed, then send it to the persistent Agent conversation.", "zh-CN": "查看已保存的提示词，需要时点击编辑，保存后再发送到持久智能代理对话。" })}</p></div><span>{prompt.data?.path ?? t({ en: "Loading prompt…", "zh-CN": "正在加载提示词…" })}{prompt.data?.version !== undefined && prompt.data.version !== null ? ` · v${formatNumber(prompt.data.version)}` : ""}{prompt.data?.hash ? ` · ${prompt.data.hash.slice(0, 10)}` : ""}</span></div>{prompt.isError && <p role="alert">{prompt.error.message}</p>}<div className="domain-agent-layout"><div className="domain-agent-editor__controls"><label className="domain-agent-prompt-field"><span>{t({ en: "Update prompt", "zh-CN": "更新提示词" })}</span><textarea aria-label={t({ en: "Domain update prompt", "zh-CN": "领域更新提示词" })} value={promptText} readOnly={!promptEditing} onChange={(event) => setPromptText(event.target.value)} rows={16} placeholder={t({ en: "Describe how the Agent should update domains…", "zh-CN": "描述智能代理应如何更新领域…" })} /></label>{promptIsDirty && <p className="domain-agent-draft-status" role="status">{t({ en: "Unsaved changes. Save before sending the prompt to Agent.", "zh-CN": "有未保存的修改。请先保存，再发送提示词给智能代理。" })}</p>}<div className="domain-agent-actions"><div className="domain-form-actions"><button type="button" onClick={() => { setPromptEditing(true); setMessage(null); }} disabled={promptEditing || prompt.isPending}>{t({ en: "Edit", "zh-CN": "编辑" })}</button><button type="button" className="button-primary" onClick={() => savePrompt.mutate()} disabled={!promptEditing || !promptIsDirty || savePrompt.isPending || prompt.isPending}>{savePrompt.isPending ? t({ en: "Saving…", "zh-CN": "保存中…" }) : t({ en: "Save", "zh-CN": "保存" })}</button><button type="button" onClick={() => restorePrompt.mutate()} disabled={restorePrompt.isPending || prompt.isPending}>{restorePrompt.isPending ? t({ en: "Restoring…", "zh-CN": "还原中…" }) : t({ en: "Restore", "zh-CN": "还原" })}</button></div><div className="domain-agent-operations"><button type="button" className="button-primary" onClick={() => usePrompt.mutate()} disabled={usePrompt.isPending || prompt.isPending || promptIsDirty || promptSavedText.trim().length === 0}>{usePrompt.isPending ? t({ en: "Opening Agent…", "zh-CN": "正在打开智能代理…" }) : domainSelection.sessionId ? t({ en: "Send prompt to Agent", "zh-CN": "发送提示词给智能代理" }) : t({ en: "Use prompt in Agent", "zh-CN": "在智能代理中使用提示词" })}</button><Link className="button-link" to={`/agent?repository=${encodeURIComponent(repositoryId)}&origin=domain${domainSelection.sessionId ? `&session=${encodeURIComponent(domainSelection.sessionId)}` : ""}`}>{t({ en: "Continue conversation", "zh-CN": "继续对话" })}</Link></div></div>{message && <p role={feedback?.tone ?? "status"}>{message}</p>}</div><div className="domain-agent-preview"><h4>{t({ en: "Current JSON file", "zh-CN": "当前 JSON 文件" })}</h4>{source.isError && <p role="alert">{source.error.message}</p>}<pre>{source.data?.content ?? t({ en: "Loading source…", "zh-CN": "正在加载源文件…" })}</pre><button type="button" onClick={() => void client.invalidateQueries({ queryKey: ["domain-source", repositoryId] })}>{t({ en: "Refresh preview", "zh-CN": "刷新预览" })}</button></div>{domainSelection.sessionId && <AgentChatPanel scope={domainScope} initialSessionId={domainSelection.sessionId} heading={t({ en: "Domain Agent", "zh-CN": "领域智能代理" })} panelId="domain-agent-chat" showCollapseControl={false} />}</div></section>}
      {view === "rendered" && <>
      <div className="domain-settings-layout">
        <div className="domain-rules" aria-label={t({ en: "Domain rules", "zh-CN": "领域规则" })}>
          {rules.length === 0 && (
            <p role="status">{t({ en: "No domain rules yet. Create the first rule on the right.", "zh-CN": "还没有领域规则。请在右侧创建第一条规则。" })}</p>
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
                  #{formatNumber(rule.position)}
                  {rule.enabled ? "" : ` · ${t({ en: "disabled", "zh-CN": "已禁用" })}`}
                </span>
              </header>
              <p>
                <strong>{t({ en: "Include:", "zh-CN": "包含：" })}</strong>{" "}
                <code>{rule.includePatterns.join(", ")}</code>
              </p>
              {rule.excludePatterns.length > 0 && (
                <p>
                  <strong>{t({ en: "Exclude:", "zh-CN": "排除：" })}</strong>{" "}
                  <code>{rule.excludePatterns.join(", ")}</code>
                </p>
              )}
              <div className="domain-rule-actions">
                <button type="button" onClick={() => startEdit(rule)}>
                  {t({ en: "Edit", "zh-CN": "编辑" })}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(t({ en: `Delete domain rule "${rule.name}"?`, "zh-CN": `删除领域规则“${rule.name}”吗？` })))
                      remove.mutate(rule);
                  }}
                  disabled={remove.isPending}
                >
                  {t({ en: "Delete", "zh-CN": "删除" })}
                </button>
              </div>
            </article>
          ))}
        </div>
        <form
          className="domain-form"
          noValidate
          aria-label={editingId === null ? t({ en: "Create domain rule", "zh-CN": "创建领域规则" }) : t({ en: "Edit domain rule", "zh-CN": "编辑领域规则" })}
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <h3>{editingId === null ? t({ en: "New rule", "zh-CN": "新规则" }) : t({ en: "Edit rule", "zh-CN": "编辑规则" })}</h3>
          <label>
            {t({ en: "Name", "zh-CN": "名称" })}
            <input
              aria-label={t({ en: "Rule name", "zh-CN": "规则名称" })}
              value={form.name}
              placeholder={t({ en: "Documentation", "zh-CN": "文档" })}
              maxLength={40}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <div className="domain-color-field">
            <span className="domain-form-field-label">{t({ en: "Color", "zh-CN": "颜色" })}</span>
            <div className="domain-color-control">
              <input
                className="domain-color-picker"
                aria-label={t({ en: "Rule color", "zh-CN": "规则颜色" })}
                title={t({ en: "Pick rule color", "zh-CN": "选择规则颜色" })}
                type="color"
                value={isDomainColor(form.color) ? form.color.trim() : defaultDomainColor}
                onChange={(event) => setForm({ ...form, color: event.target.value })}
              />
              <input
                className="domain-color-hex"
                aria-label={t({ en: "Rule color hex value", "zh-CN": "规则颜色十六进制值" })}
                aria-invalid={!isDomainColor(form.color)}
                aria-describedby="domain-color-help"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={7}
                pattern="#[0-9a-fA-F]{6}"
                value={form.color}
                onChange={(event) => setForm({ ...form, color: event.target.value })}
              />
            </div>
            <span id="domain-color-help" className="domain-color-help">{t({ en: "Use a six-digit hexadecimal value, for example #5b8def.", "zh-CN": "请输入六位十六进制值，例如 #5b8def。" })}</span>
          </div>
          <label>
            {t({ en: "Include patterns (one pattern per line)", "zh-CN": "包含模式（每行一个）" })}
            <textarea
              aria-label={t({ en: "Include patterns", "zh-CN": "包含模式" })}
              rows={4}
              value={form.include}
              placeholder={"docs/**\nREADME.md"}
              onChange={(event) => setForm({ ...form, include: event.target.value })}
            />
          </label>
          <label>
            {t({ en: "Exclude patterns (one pattern per line)", "zh-CN": "排除模式（每行一个）" })}
            <textarea
              aria-label={t({ en: "Exclude patterns", "zh-CN": "排除模式" })}
              rows={3}
              value={form.exclude}
              placeholder={"docs/generated/**\n**/*.snap"}
              onChange={(event) => setForm({ ...form, exclude: event.target.value })}
            />
          </label>
          <SettingsSwitch
            label={t({ en: "Rule enabled", "zh-CN": "启用规则" })}
            description={t({ en: "Include this rule in the rendered domain projection.", "zh-CN": "在渲染的领域投影中包含此规则。" })}
            checked={form.enabled}
            onChange={(enabled) => setForm({ ...form, enabled })}
          />
          <div className="domain-form-actions">
            <button type="submit" disabled={submit.isPending}>
              {editingId === null ? t({ en: "Create rule", "zh-CN": "创建规则" }) : t({ en: "Save changes", "zh-CN": "保存更改" })}
            </button>
            {editingId !== null && (
              <button type="button" onClick={resetForm}>
                {t({ en: "Cancel", "zh-CN": "取消" })}
              </button>
            )}
          </div>
          {message && (
            <p
              role={feedback?.tone ?? "status"}
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
