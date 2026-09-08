import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DomainRule } from "@loongboard/contracts";
import { useDomains, useRepositories } from "../../app/hooks";
import {
  createDomainRule,
  deleteDomainRule,
  updateDomainRule,
} from "../../domains-client";

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
    </section>
  );
}
