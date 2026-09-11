import { useEffect, useState } from "react";
import { fetchHealth } from "../../health-client";
import { useI18n } from "../../i18n";

export function HealthStatus() {
  const { t } = useI18n();
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
  if (status === "loading") return <p role="status">{t({ en: "Checking API health…", "zh-CN": "正在检查 API 健康状态…" })}</p>;
  if (status === "error")
    return <p role="alert">{t({ en: "API health check failed:", "zh-CN": "API 健康检查失败：" })} {error}</p>;
  return <p role="status">{t({ en: "API status: healthy", "zh-CN": "API 状态：正常" })}</p>;
}
