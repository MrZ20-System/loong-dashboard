import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";

const settingsTabs = [
  { to: "/settings/repositories", label: { en: "Repositories", "zh-CN": "仓库" } },
  { to: "/settings/integrations", label: { en: "Integrations", "zh-CN": "集成" } },
  { to: "/settings/agent", label: { en: "Agent", "zh-CN": "智能代理" } },
  { to: "/settings/personal-data", label: { en: "Personal Data", "zh-CN": "个人数据" } },
  { to: "/settings/code-backup", label: { en: "Code backup", "zh-CN": "代码备份" } },
  { to: "/settings/domains", label: { en: "Domains", "zh-CN": "领域" } },
  { to: "/settings/schedules", label: { en: "Schedules", "zh-CN": "计划任务" } },
  { to: "/settings/health", label: { en: "Health", "zh-CN": "健康状态" } },
  { to: "/settings/security", label: { en: "Security", "zh-CN": "安全" } },
] as const;

export function SettingsShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="settings-area" aria-labelledby="settings-area-heading">
      <header className="page-heading settings-area__heading">
        <div>
          <p className="eyebrow">{t({ en: "Settings", "zh-CN": "设置" })}</p>
          <h2 id="settings-area-heading">{t({ en: "LoongBoard settings", "zh-CN": "LoongBoard 设置" })}</h2>
        </div>
      </header>
      <nav className="settings-tabs" aria-label={t({ en: "Settings sections", "zh-CN": "设置分区" })}>
        {settingsTabs.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              isActive ? "settings-tabs__item settings-tabs__item--active" : "settings-tabs__item"
            }
          >
            {t(label)}
          </NavLink>
        ))}
      </nav>
      {children}
    </section>
  );
}
