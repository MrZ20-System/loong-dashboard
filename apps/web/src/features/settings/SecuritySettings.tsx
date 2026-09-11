import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  disableAuth,
  fetchAuthStatus,
  logoutAuth,
  updateAuthPassword,
} from "../../auth-client";

export function SecuritySettings() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["auth-status"], queryFn: () => fetchAuthStatus() });
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => updateAuthPassword({
      password,
      ...(status.data?.enabled && currentPassword.length > 0 ? { currentPassword } : {}),
    }),
    onSuccess: (next) => {
      client.setQueryData(["auth-status"], next);
      setCurrentPassword("");
      setPassword("");
      setMessage(next.enabled ? "Password lock enabled and session refreshed." : "Password lock disabled.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const disable = useMutation({
    mutationFn: disableAuth,
    onSuccess: (next) => {
      client.setQueryData(["auth-status"], next);
      setMessage("Password lock disabled.");
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const logout = useMutation({
    mutationFn: logoutAuth,
    onSuccess: () => {
      setMessage("Signed out. Reloading…");
      window.location.reload();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const enabled = status.data?.enabled === true;

  return (
    <div className="settings-stack">
      <section className="settings-card" aria-labelledby="security-heading">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">Security</p>
            <h3 id="security-heading">Password lock</h3>
            <p className="settings-muted">Protects this Web/API surface only. Local data is not encrypted.</p>
          </div>
          <span className={`status-pill status-pill--${enabled ? "ok" : "unknown"}`}>{enabled ? "Enabled" : "Off"}</span>
        </header>
        {status.isPending && <p role="status">Loading password lock…</p>}
        {status.isError && <p role="alert" className="settings-error">{status.error.message}</p>}
        <form className="settings-stack" onSubmit={(event) => { event.preventDefault(); if (password.length > 0) save.mutate(); }}>
          {enabled && (
            <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          )}
          <label>{enabled ? "New password" : "Set password"}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="settings-form-row">
            <button type="submit" className="button-primary" disabled={save.isPending || password.length === 0}>{enabled ? "Change password" : "Enable password lock"}</button>
            {enabled && <button type="button" onClick={() => disable.mutate()} disabled={disable.isPending}>Disable lock</button>}
            {enabled && <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>Log out</button>}
          </div>
        </form>
        {message !== null && <p role="status" className="settings-message">{message}</p>}
      </section>
    </div>
  );
}
