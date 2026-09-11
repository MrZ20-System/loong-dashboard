import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { AuthStatus } from "@loongboard/contracts";

import { fetchAuthStatus, unlockAuth } from "../../auth-client";
import { AUTH_REQUIRED_EVENT } from "../../auth-required-event";
import { LocaleToggle, useI18n } from "../../i18n";

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    const controller = new AbortController();
    void fetchAuthStatus(controller.signal).then(setStatus).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    const handleAuthRequired = () => {
      setStatus((current) =>
        current === null ? current : { ...current, unlocked: false },
      );
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  if (error !== null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-labelledby="auth-error-heading">
          <LocaleToggle />
          <h1 id="auth-error-heading">LoongBoard</h1>
          <p role="alert">{t({ en: "Unable to check the password lock:", "zh-CN": "无法检查密码锁：" })} {error.message}</p>
          <button type="button" className="button-primary" onClick={() => { setStatus(null); refresh(); }}>
            {t({ en: "Try again", "zh-CN": "重试" })}
          </button>
        </section>
      </main>
    );
  }

  if (status === null) {
    return <main className="auth-screen"><div className="auth-card"><LocaleToggle /><p role="status">{t({ en: "Checking password lock…", "zh-CN": "正在检查密码锁…" })}</p></div></main>;
  }

  if (!status.unlocked) {
    return <UnlockScreen onUnlocked={setStatus} />;
  }

  return <>{children}</>;
}

function UnlockScreen({ onUnlocked }: { onUnlocked: (status: AuthStatus) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length === 0 || pending) return;
    setPending(true);
    setError(null);
    try {
      const status = await unlockAuth(password);
      setPassword("");
      onUnlocked(status);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t({ en: "Unable to unlock LoongBoard", "zh-CN": "无法解锁 LoongBoard" }));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="unlock-heading">
        <LocaleToggle />
        <div className="brand-mark" aria-hidden="true">LB</div>
        <p className="eyebrow">{t({ en: "Local engineering workspace", "zh-CN": "本地工程工作区" })}</p>
        <h1 id="unlock-heading">LoongBoard</h1>
        <p className="auth-card__hint">{t({ en: "Enter your local password to continue.", "zh-CN": "请输入本地密码继续。" })}</p>
        <form onSubmit={submit}>
          <label>
            {t({ en: "Password", "zh-CN": "密码" })}
            <input
              aria-label={t({ en: "Password", "zh-CN": "密码" })}
              autoComplete="current-password"
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error !== null && <p role="alert" className="settings-error">{error}</p>}
          <button type="submit" className="button-primary" disabled={pending || password.length === 0}>
            {pending ? t({ en: "Unlocking…", "zh-CN": "解锁中…" }) : t({ en: "Unlock", "zh-CN": "解锁" })}
          </button>
        </form>
      </section>
    </main>
  );
}
