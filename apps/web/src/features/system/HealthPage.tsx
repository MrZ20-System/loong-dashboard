import { HealthStatus } from "./HealthStatus";
import { useI18n } from "../../i18n";

export function HealthPage() {
  const { t } = useI18n();
  return (
    <section className="plain-page" aria-labelledby="health-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t({ en: "System", "zh-CN": "系统" })}</p>
          <h2 id="health-heading">{t({ en: "Service health", "zh-CN": "服务健康状态" })}</h2>
        </div>
      </div>
      <div className="plain-page__card">
        <p className="page-subtitle">
          {t({ en: "The web shell checks the API boundary without hiding failures.", "zh-CN": "Web 外壳检查 API 边界，不隐藏失败。" })}
        </p>
        <HealthStatus />
      </div>
    </section>
  );
}
