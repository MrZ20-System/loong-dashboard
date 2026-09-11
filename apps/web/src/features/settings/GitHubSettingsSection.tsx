import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchGitHubIntegration,
  removeGitHubToken,
  saveGitHubToken,
  verifyGitHubIntegration,
  type GitHubIntegration,
} from "../../settings-client";
import { ErrorText } from "./settings-helpers";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function GitHubSettingsSection() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const client = useQueryClient();
  const integration = useQuery({ queryKey: ["github-integration"], queryFn: fetchGitHubIntegration });
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => saveGitHubToken(token),
    onSuccess: (data) => {
      setToken("");
      setMessage({ message: { en: "Token saved securely. The secret is never displayed.", "zh-CN": "令牌已安全保存。密钥不会显示。" } });
      client.setQueryData(["github-integration"], data);
    },
    onError: (error: Error) => setMessage({ message: { en: "Saving the token failed: {detail}", "zh-CN": "保存令牌失败：{detail}" }, values: { detail: error.message } }),
  });
  const verify = useMutation({
    mutationFn: verifyGitHubIntegration,
    onSuccess: (data) => {
      setMessage({ message: { en: "GitHub connection verified.", "zh-CN": "GitHub 连接已验证。" } });
      client.setQueryData(["github-integration"], data);
    },
    onError: (error: Error) => setMessage({ message: { en: "Verifying GitHub failed: {detail}", "zh-CN": "验证 GitHub 失败：{detail}" }, values: { detail: error.message } }),
  });
  const remove = useMutation({
    mutationFn: removeGitHubToken,
    onSuccess: () => {
      setMessage({ message: { en: "GitHub credential removed.", "zh-CN": "GitHub 凭据已移除。" } });
      void client.invalidateQueries({ queryKey: ["github-integration"] });
    },
    onError: (error: Error) => setMessage({ message: { en: "Removing the GitHub credential failed: {detail}", "zh-CN": "移除 GitHub 凭据失败：{detail}" }, values: { detail: error.message } }),
  });
  const data = integration.data as GitHubIntegration | undefined;

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">GitHub</p>
            <h3>{t({ en: "GitHub integration", "zh-CN": "GitHub 集成" })}</h3>
          </div>
          <span className={`status-pill status-pill--${data?.configured ? "ok" : "unknown"}`}>
            {data?.configured ? t({ en: "Configured", "zh-CN": "已配置" }) : t({ en: "Not configured", "zh-CN": "未配置" })}
          </span>
        </header>
        {integration.isError && <ErrorText error={integration.error} />}
        <dl className="settings-details">
          <div><dt>{t({ en: "Credential source", "zh-CN": "凭据来源" })}</dt><dd>{data?.source ?? "—"}</dd></div>
          <div><dt>{t({ en: "Verified account", "zh-CN": "已验证账户" })}</dt><dd>{data?.account?.login ?? "—"}</dd></div>
          <div><dt>{t({ en: "REST quota", "zh-CN": "REST 配额" })}</dt><dd>{data?.rest?.remaining !== undefined ? `${formatNumber(data.rest.remaining)} / ${data.rest.limit !== undefined ? formatNumber(data.rest.limit) : "?"}` : "—"}</dd></div>
          <div><dt>{t({ en: "GraphQL quota", "zh-CN": "GraphQL 配额" })}</dt><dd>{data?.graphql?.remaining !== undefined ? `${formatNumber(data.graphql.remaining)} / ${data.graphql.limit !== undefined ? formatNumber(data.graphql.limit) : "?"}` : "—"}</dd></div>
          <div><dt>{t({ en: "Rate limit reset", "zh-CN": "速率限制重置" })}</dt><dd>{data?.rest?.resetAt ? formatDateTime(data.rest.resetAt) : "—"}</dd></div>
          <div><dt>{t({ en: "Last verified", "zh-CN": "上次验证" })}</dt><dd>{data?.lastVerifiedAt ? formatDateTime(data.lastVerifiedAt) : "—"}</dd></div>
        </dl>
        <form
          className="secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) save.mutate();
          }}
        >
          <label>
            {data?.configured ? t({ en: "Replace token", "zh-CN": "替换令牌" }) : t({ en: "Personal access token", "zh-CN": "个人访问令牌" })}
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={data?.configured ? t({ en: "Enter a replacement token", "zh-CN": "输入替换令牌" }) : t({ en: "Token is never echoed", "zh-CN": "令牌不会回显" })}
            />
          </label>
          <div className="settings-form-row">
            <button type="submit" className="button-primary" disabled={!token.trim() || save.isPending}>{t({ en: "Save credential", "zh-CN": "保存凭据" })}</button>
            <button type="button" onClick={() => verify.mutate()} disabled={!data?.configured || verify.isPending}>{t({ en: "Test connection", "zh-CN": "测试连接" })}</button>
            <button type="button" className="button-danger" onClick={() => remove.mutate()} disabled={!data?.configured || remove.isPending}>{t({ en: "Remove", "zh-CN": "移除" })}</button>
          </div>
        </form>
        {message && <p role={save.isError || verify.isError || remove.isError ? "alert" : "status"} className="settings-message">{t(message.message, message.values)}</p>}
      </section>
    </div>
  );
}

export { GitHubSettingsSection as IntegrationsSettings };
