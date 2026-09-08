import { useEffect, useState } from "react";
import { fetchHealth } from "../../health-client";

export function HealthStatus() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchHealth()
      .then(() => active && setStatus("ok"))
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
  if (status === "loading") return <p role="status">Checking API health…</p>;
  if (status === "error")
    return <p role="alert">API health check failed: {error}</p>;
  return <p role="status">API status: healthy</p>;
}
