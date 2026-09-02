import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { fetchHealth } from "./health-client";

function HealthStatus() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetchHealth()
      .then(() => {
        if (active) {
          setStatus("ok");
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setStatus("error");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (status === "loading") {
    return <p role="status">Checking API health…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert">
        API health check failed: {error}
      </p>
    );
  }

  return <p role="status">API status: healthy</p>;
}

function HomePage() {
  return (
    <section aria-labelledby="welcome-heading">
      <p className="eyebrow">Local-first engineering workspace</p>
      <h2 id="welcome-heading">A clear view of your repositories and knowledge.</h2>
      <p>
        LoongBoard brings local Git workspaces, durable Markdown knowledge, and
        coding-agent sessions together in one focused board.
      </p>
      <HealthStatus />
    </section>
  );
}

function HealthPage() {
  return (
    <section aria-labelledby="health-heading">
      <p className="eyebrow">System</p>
      <h2 id="health-heading">Service health</h2>
      <p>The web shell checks the API boundary without hiding failures.</p>
      <HealthStatus />
    </section>
  );
}

function NotFoundPage() {
  return (
    <section aria-labelledby="not-found-heading">
      <p className="eyebrow">Not found</p>
      <h2 id="not-found-heading">This LoongBoard route does not exist.</h2>
      <Link to="/">Return to the board</Link>
    </section>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="brand-mark">LB</p>
          <h1>LoongBoard</h1>
          <p className="tagline">Your local engineering command center</p>
        </div>
        <nav aria-label="Primary navigation">
          <Link to="/">Board</Link>
          <Link to="/health">Health</Link>
        </nav>
      </header>
      <main className="app-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="app-footer">Stage 0 · Foundation</footer>
    </div>
  );
}
