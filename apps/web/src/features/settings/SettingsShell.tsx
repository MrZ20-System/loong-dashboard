import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

const settingsTabs = [
  { to: "/settings/repositories", label: "Repositories", end: false },
  { to: "/settings/integrations", label: "Integrations", end: false },
  { to: "/settings/agent", label: "Agent", end: false },
  { to: "/settings/checkpoint", label: "Checkpoint", end: false },
  { to: "/settings/domains", label: "Domains", end: false },
  { to: "/settings/schedules", label: "Schedules", end: false },
  { to: "/settings/health", label: "Health", end: false },
] as const;

export function SettingsShell({ children }: { children: ReactNode }) {
  return (
    <section className="settings-area" aria-labelledby="settings-area-heading">
      <header className="page-heading settings-area__heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h2 id="settings-area-heading">LoongBoard settings</h2>
        </div>
      </header>
      <nav className="settings-tabs" aria-label="Settings sections">
        {settingsTabs.map(({ to, label }) => (
          <NavLink
            key={label}
            to={to}
            className={({ isActive }) =>
              isActive ? "settings-tabs__item settings-tabs__item--active" : "settings-tabs__item"
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {children}
    </section>
  );
}
