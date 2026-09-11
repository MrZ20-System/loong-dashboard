import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentRuntimeModelCapability } from "@loongboard/contracts";
import {
  fetchAgentRuntimeSettings,
  saveProviderSecret,
  updateAgentRuntimeSettings,
  type AgentRuntimeSettings,
} from "../../settings-client";
import { ErrorText } from "./settings-helpers";

export function AgentSettingsSection() {
  const client = useQueryClient();
  const runtime = useQuery({ queryKey: ["agent-runtime-settings"], queryFn: fetchAgentRuntimeSettings });
  const [draft, setDraft] = useState<Partial<AgentRuntimeSettings>>({});
  const [provider, setProvider] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => updateAgentRuntimeSettings({ defaultProvider: draft.defaultProvider, defaultModel: draft.defaultModel, defaultReasoning: draft.defaultReasoning, retentionMinutes: draft.retentionMinutes }),
    onSuccess: (data) => {
      client.setQueryData(["agent-runtime-settings"], data);
      setMessage("Agent defaults saved.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const secretSave = useMutation({
    mutationFn: () => saveProviderSecret(provider, secret),
    onSuccess: () => {
      setSecret("");
      setMessage("Provider secret saved. The secret is never echoed.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const data = { ...runtime.data, ...draft };
  const capabilities = runtime.data?.capabilities;
  const modelOptions = capabilities?.models ?? [];
  const selectedModel = modelOptions.find((model) => model.id === data.defaultModel);
  const providerOptions = Array.from(new Set([
    ...(capabilities?.providers ?? []).map((provider) => provider.id),
    ...modelOptions.map((model) => model.provider),
    ...(data.defaultProvider ? [data.defaultProvider] : []),
  ]));
  const reasoningOptions = Array.from(new Set([
    ...selectedModel?.reasoningEfforts ?? capabilities?.reasoning ?? [],
    ...(data.defaultReasoning ? [data.defaultReasoning] : []),
  ]));
  const retentionOptions = Array.from(new Set([30, 60, 120, 240, 0, ...(data.retentionMinutes !== undefined ? [data.retentionMinutes] : [])]));
  const retention = data.retentionMinutes ?? 120;

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">DSH runtime</p>
            <h3>Agent defaults</h3>
          </div>
          <span className={`status-pill status-pill--${data.connected === false ? "error" : "ok"}`}>
            {data.status ?? (data.connected === false ? "Offline" : "Ready")}
          </span>
        </header>
        {runtime.isError && <ErrorText error={runtime.error} />}
        <dl className="settings-details">
          <div><dt>Runtime version</dt><dd>{data.version ?? "—"}</dd></div>
          <div><dt>Profile</dt><dd>{data.profile ?? "—"}</dd></div>
        </dl>
        <div className="settings-grid">
          <label>
            Default provider
            <select value={data.defaultProvider ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultProvider: event.target.value || null }))}>
              <option value="">Runtime default</option>
              {providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            Default model
            <select
              value={data.defaultModel ?? ""}
              onChange={(event) => {
                const nextModel = modelOptions.find((item) => item.id === event.target.value);
                setDraft((old: Partial<AgentRuntimeSettings>) => ({
                  ...old,
                  defaultModel: event.target.value || null,
                  ...(nextModel ? { defaultProvider: nextModel.provider } : {}),
                }));
              }}
            >
              <option value="">Runtime default</option>
              {data.defaultModel && selectedModel === undefined && <option value={data.defaultModel}>{data.defaultModel} · saved</option>}
              {modelOptions.map((model: AgentRuntimeModelCapability) => <option key={model.id} value={model.id}>{model.label ?? model.id} · {model.provider}</option>)}
            </select>
          </label>
          <label>
            Default reasoning
            <select value={data.defaultReasoning ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultReasoning: event.target.value || null }))}>
              <option value="">Runtime default</option>
              {reasoningOptions.map((reasoning: string) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
            </select>
          </label>
          <label>
            Idle process retention
            <select value={retention} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, retentionMinutes: Number(event.target.value) }))}>
              {retentionOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} minutes`}{minutes === data.retentionMinutes && ![30, 60, 120, 240, 0].includes(minutes) ? " · saved" : ""}</option>)}
            </select>
          </label>
        </div>
        <div className="settings-form-row">
          <button className="button-primary" type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save defaults</button>
          <button type="button" onClick={() => void runtime.refetch()} disabled={runtime.isFetching}>Test connection</button>
        </div>
        {message && <p role={save.isError || secretSave.isError ? "alert" : "status"} className="settings-message">{message}</p>}
        <hr />
        <h4>Provider connection</h4>
        <form
          className="secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (provider && secret) secretSave.mutate();
          }}
        >
          <label>
            Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">Choose a runtime provider</option>
              {providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            API secret
            <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Secret is never echoed" />
          </label>
          <button type="submit" disabled={!provider || !secret || secretSave.isPending}>Save provider secret</button>
        </form>
      </section>
    </div>
  );
}

export { AgentSettingsSection as AgentSettings };
