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

export function GitHubSettingsSection() {
  const client = useQueryClient();
  const integration = useQuery({ queryKey: ["github-integration"], queryFn: fetchGitHubIntegration });
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => saveGitHubToken(token),
    onSuccess: (data) => {
      setToken("");
      setMessage("Token saved securely. The secret is never displayed.");
      client.setQueryData(["github-integration"], data);
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const verify = useMutation({
    mutationFn: verifyGitHubIntegration,
    onSuccess: (data) => {
      setMessage("GitHub connection verified.");
      client.setQueryData(["github-integration"], data);
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const remove = useMutation({
    mutationFn: removeGitHubToken,
    onSuccess: () => {
      setMessage("GitHub credential removed.");
      void client.invalidateQueries({ queryKey: ["github-integration"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const data = integration.data as GitHubIntegration | undefined;

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">GitHub</p>
            <h3>GitHub integration</h3>
          </div>
          <span className={`status-pill status-pill--${data?.configured ? "ok" : "unknown"}`}>
            {data?.configured ? "Configured" : "Not configured"}
          </span>
        </header>
        {integration.isError && <ErrorText error={integration.error} />}
        <dl className="settings-details">
          <div><dt>Credential source</dt><dd>{data?.source ?? "—"}</dd></div>
          <div><dt>Verified account</dt><dd>{data?.account?.login ?? "—"}</dd></div>
          <div><dt>REST quota</dt><dd>{data?.rest?.remaining !== undefined ? `${data.rest.remaining} / ${data.rest.limit ?? "?"}` : "—"}</dd></div>
          <div><dt>GraphQL quota</dt><dd>{data?.graphql?.remaining !== undefined ? `${data.graphql.remaining} / ${data.graphql.limit ?? "?"}` : "—"}</dd></div>
          <div><dt>Rate limit reset</dt><dd>{data?.rest?.resetAt ? new Date(data.rest.resetAt).toLocaleString() : "—"}</dd></div>
          <div><dt>Last verified</dt><dd>{data?.lastVerifiedAt ? new Date(data.lastVerifiedAt).toLocaleString() : "—"}</dd></div>
        </dl>
        <form
          className="secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) save.mutate();
          }}
        >
          <label>
            {data?.configured ? "Replace token" : "Personal access token"}
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={data?.configured ? "Enter a replacement token" : "Token is never echoed"}
            />
          </label>
          <div className="settings-form-row">
            <button type="submit" className="button-primary" disabled={!token.trim() || save.isPending}>Save credential</button>
            <button type="button" onClick={() => verify.mutate()} disabled={!data?.configured || verify.isPending}>Test connection</button>
            <button type="button" className="button-danger" onClick={() => remove.mutate()} disabled={!data?.configured || remove.isPending}>Remove</button>
          </div>
        </form>
        {message && <p role={message.includes("failed") || message.includes("HTTP") ? "alert" : "status"} className="settings-message">{message}</p>}
      </section>
    </div>
  );
}

export { GitHubSettingsSection as IntegrationsSettings };
