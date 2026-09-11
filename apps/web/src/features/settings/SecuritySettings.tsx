import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n, type LocalizedMessage, type MessageValues } from "../../i18n";

import {
  disableAuth,
  fetchAuthStatus,
  logoutAuth,
  updateAuthPassword,
} from "../../auth-client";

type Feedback = { message: LocalizedMessage; values?: MessageValues };

export function SecuritySettings() {
  const { t } = useI18n();
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["auth-status"], queryFn: () => fetchAuthStatus() });
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<Feedback | null>(null);
  const save = useMutation({
    mutationFn: () => updateAuthPassword({
      password,
      ...(status.data?.enabled && currentPassword.length > 0 ? { currentPassword } : {}),
    }),
    onSuccess: (next) => {
      client.setQueryData(["auth-status"], next);
      setCurrentPassword("");
      setPassword("");
      setMessage({ message: next.enabled ? { en: "Password lock enabled and session refreshed.", "zh-CN": "密码锁已启用，会话已刷新。" } : { en: "Password lock disabled.", "zh-CN": "密码锁已禁用。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Updating the password lock failed: {detail}", "zh-CN": "更新密码锁失败：{detail}" }, values: { detail: error.message } }),
  });
  const disable = useMutation({
    mutationFn: disableAuth,
    onSuccess: (next) => {
      client.setQueryData(["auth-status"], next);
      setMessage({ message: { en: "Password lock disabled.", "zh-CN": "密码锁已禁用。" } });
    },
    onError: (error: Error) => setMessage({ message: { en: "Disabling the password lock failed: {detail}", "zh-CN": "禁用密码锁失败：{detail}" }, values: { detail: error.message } }),
  });
  const logout = useMutation({
    mutationFn: logoutAuth,
    onSuccess: () => {
      setMessage({ message: { en: "Signed out. Reloading…", "zh-CN": "已退出登录。正在重新加载…" } });
      window.location.reload();
    },
    onError: (error: Error) => setMessage({ message: { en: "Signing out failed: {detail}", "zh-CN": "退出登录失败：{detail}" }, values: { detail: error.message } }),
  });
  const enabled = status.data?.enabled === true;

  return (
    <div className="settings-stack">
      <section className="settings-card" aria-labelledby="security-heading">
        <header className="settings-card__header">
          <div>
            <p className="eyebrow">{t({ en: "Security", "zh-CN": "安全" })}</p>
            <h3 id="security-heading">{t({ en: "Password lock", "zh-CN": "密码锁" })}</h3>
            <p className="settings-muted">{t({ en: "Protects this Web/API surface only. Local data is not encrypted.", "zh-CN": "仅保护此 Web/API 界面。本地数据未加密。" })}</p>
          </div>
          <span className={`status-pill status-pill--${enabled ? "ok" : "unknown"}`}>{enabled ? t({ en: "Enabled", "zh-CN": "已启用" }) : t({ en: "Off", "zh-CN": "关闭" })}</span>
        </header>
        {status.isPending && <p role="status">{t({ en: "Loading password lock…", "zh-CN": "正在加载密码锁…" })}</p>}
        {status.isError && <p role="alert" className="settings-error">{status.error.message}</p>}
        <form className="settings-stack" onSubmit={(event) => { event.preventDefault(); if (password.length > 0) save.mutate(); }}>
          {enabled && (
            <label>{t({ en: "Current password", "zh-CN": "当前密码" })}<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          )}
          <label>{enabled ? t({ en: "New password", "zh-CN": "新密码" }) : t({ en: "Set password", "zh-CN": "设置密码" })}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="settings-form-row">
            <button type="submit" className="button-primary" disabled={save.isPending || password.length === 0}>{enabled ? t({ en: "Change password", "zh-CN": "更改密码" }) : t({ en: "Enable password lock", "zh-CN": "启用密码锁" })}</button>
            {enabled && <button type="button" onClick={() => disable.mutate()} disabled={disable.isPending}>{t({ en: "Disable lock", "zh-CN": "禁用密码锁" })}</button>}
            {enabled && <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>{t({ en: "Log out", "zh-CN": "退出登录" })}</button>}
          </div>
        </form>
        {message !== null && <p role={save.isError || disable.isError || logout.isError ? "alert" : "status"} className="settings-message">{t(message.message, message.values)}</p>}
      </section>
    </div>
  );
}
