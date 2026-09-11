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
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function AgentSettingsSection() {
  const { t, formatNumber } = useI18n();
  const client = useQueryClient();
  const runtime = useQuery({ queryKey: ["agent-runtime-settings"], queryFn: fetchAgentRuntimeSettings });
  const [draft, setDraft] = useState<Partial<AgentRuntimeSettings>>({});
  const [provider, setProvider] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => updateAgentRuntimeSettings({ defaultProvider: draft.defaultProvider, defaultModel: draft.defaultModel, defaultReasoning: draft.defaultReasoning, retentionMinutes: draft.retentionMinutes }),
    onSuccess: (data) => {
      client.setQueryData(["agent-runtime-settings"], data);
      setMessage({ message: { en: "Agent defaults saved.", "zh-CN": "智能代理默认设置已保存。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving Agent defaults failed: {detail}", "zh-CN": "保存智能代理默认设置失败：{detail}" }, values: { detail: error.message } }),
  });
  const secretSave = useMutation({
    mutationFn: () => saveProviderSecret(provider, secret),
    onSuccess: () => {
      setSecret("");
      setMessage({ message: { en: "Provider secret saved. The secret is never echoed.", "zh-CN": "提供商密钥已保存。密钥不会回显。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving the provider secret failed: {detail}", "zh-CN": "保存提供商密钥失败：{detail}" }, values: { detail: error.message } }),
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
            <p className="eyebrow">{t({ en: "DSH runtime", "zh-CN": "DSH 运行时" })}</p>
            <h3>{t({ en: "Agent defaults", "zh-CN": "智能代理默认设置" })}</h3>
          </div>
          <span className={`status-pill status-pill--${data.connected === false ? "error" : "ok"}`}>
            {data.status ?? (data.connected === false ? t({ en: "Offline", "zh-CN": "离线" }) : t({ en: "Ready", "zh-CN": "就绪" }))}
          </span>
        </header>
        {runtime.isError && <ErrorText error={runtime.error} />}
        <dl className="settings-details">
          <div><dt>{t({ en: "Runtime version", "zh-CN": "运行时版本" })}</dt><dd>{data.version ?? "—"}</dd></div>
          <div><dt>{t({ en: "Profile", "zh-CN": "配置档案" })}</dt><dd>{data.profile ?? "—"}</dd></div>
        </dl>
        <div className="settings-grid">
          <label>
            {t({ en: "Default provider", "zh-CN": "默认提供商" })}
            <select value={data.defaultProvider ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultProvider: event.target.value || null }))}>
              <option value="">{t({ en: "Runtime default", "zh-CN": "运行时默认" })}</option>
              {providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            {t({ en: "Default model", "zh-CN": "默认模型" })}
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
              <option value="">{t({ en: "Runtime default", "zh-CN": "运行时默认" })}</option>
              {data.defaultModel && selectedModel === undefined && <option value={data.defaultModel}>{data.defaultModel} · {t({ en: "saved", "zh-CN": "已保存" })}</option>}
              {modelOptions.map((model: AgentRuntimeModelCapability) => <option key={model.id} value={model.id}>{model.label ?? model.id} · {model.provider}</option>)}
            </select>
          </label>
          <label>
            {t({ en: "Default reasoning", "zh-CN": "默认推理强度" })}
            <select value={data.defaultReasoning ?? ""} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, defaultReasoning: event.target.value || null }))}>
              <option value="">{t({ en: "Runtime default", "zh-CN": "运行时默认" })}</option>
              {reasoningOptions.map((reasoning: string) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
            </select>
          </label>
          <label>
            {t({ en: "Idle process retention", "zh-CN": "空闲进程保留" })}
            <select value={retention} onChange={(event) => setDraft((old: Partial<AgentRuntimeSettings>) => ({ ...old, retentionMinutes: Number(event.target.value) }))}>
              {retentionOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? t({ en: "Never", "zh-CN": "永不" }) : `${formatNumber(minutes)} ${t({ en: "minutes", "zh-CN": "分钟" })}`}{minutes === data.retentionMinutes && ![30, 60, 120, 240, 0].includes(minutes) ? ` · ${t({ en: "saved", "zh-CN": "已保存" })}` : ""}</option>)}
            </select>
          </label>
        </div>
        <div className="settings-form-row">
          <button className="button-primary" type="button" onClick={() => save.mutate()} disabled={save.isPending}>{t({ en: "Save defaults", "zh-CN": "保存默认设置" })}</button>
          <button type="button" onClick={() => void runtime.refetch()} disabled={runtime.isFetching}>{t({ en: "Test connection", "zh-CN": "测试连接" })}</button>
        </div>
        {message && <p role={save.isError || secretSave.isError ? "alert" : "status"} className="settings-message">{t(message.message, message.values)}</p>}
        <hr />
        <h4>{t({ en: "Provider connection", "zh-CN": "提供商连接" })}</h4>
        <form
          className="secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (provider && secret) secretSave.mutate();
          }}
        >
          <label>
            {t({ en: "Provider", "zh-CN": "提供商" })}
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">{t({ en: "Choose a runtime provider", "zh-CN": "选择运行时提供商" })}</option>
              {providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            {t({ en: "API secret", "zh-CN": "API 密钥" })}
            <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={t({ en: "Secret is never echoed", "zh-CN": "密钥不会回显" })} />
          </label>
          <button type="submit" disabled={!provider || !secret || secretSave.isPending}>{t({ en: "Save provider secret", "zh-CN": "保存提供商密钥" })}</button>
        </form>
      </section>
    </div>
  );
}

export { AgentSettingsSection as AgentSettings };
