import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { AuthStatus } from "@loongboard/contracts";

import { fetchAuthStatus, unlockAuth } from "../../auth-client";

export function AuthGate({ children }: { children: ReactNode }) {
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

  if (error !== null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-labelledby="auth-error-heading">
          <h1 id="auth-error-heading">LoongBoard</h1>
          <p role="alert">Unable to check the password lock: {error.message}</p>
          <button type="button" className="button-primary" onClick={() => { setStatus(null); refresh(); }}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (status === null) {
    return <main className="auth-screen"><p role="status">Checking password lock…</p></main>;
  }

  if (status.enabled && !status.unlocked) {
    return <UnlockScreen onUnlocked={setStatus} />;
  }

  return <>{children}</>;
}

function UnlockScreen({ onUnlocked }: { onUnlocked: (status: AuthStatus) => void }) {
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
      setError(cause instanceof Error ? cause.message : "Unable to unlock LoongBoard");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="unlock-heading">
        <div className="brand-mark" aria-hidden="true">LB</div>
        <p className="eyebrow">Local engineering workspace</p>
        <h1 id="unlock-heading">LoongBoard</h1>
        <p className="auth-card__hint">Enter your local password to continue.</p>
        <form onSubmit={submit}>
          <label>
            Password
            <input
              aria-label="Password"
              autoComplete="current-password"
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error !== null && <p role="alert" className="settings-error">{error}</p>}
          <button type="submit" className="button-primary" disabled={pending || password.length === 0}>
            {pending ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </section>
    </main>
  );
}
