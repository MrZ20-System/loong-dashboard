import { LocaleToggle, useI18n } from "../i18n";
import type { AppTheme } from "../knowledge-editor";
import { shellMessages } from "./messages";

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: AppTheme;
  onChange: (theme: AppTheme) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="theme-toggle" role="group" aria-label={t(shellMessages.colorTheme)}>
      <button
        type="button"
        className={theme === "light" ? "theme-toggle__item theme-toggle__item--active" : "theme-toggle__item"}
        aria-pressed={theme === "light"}
        aria-label={t(shellMessages.light)}
        title={t(shellMessages.light)}
        onClick={() => onChange("light")}
      >
        <span className="theme-toggle__icon" aria-hidden="true">☀</span>
      </button>
      <button
        type="button"
        className={theme === "dark" ? "theme-toggle__item theme-toggle__item--active" : "theme-toggle__item"}
        aria-pressed={theme === "dark"}
        aria-label={t(shellMessages.dark)}
        title={t(shellMessages.dark)}
        onClick={() => onChange("dark")}
      >
        <span className="theme-toggle__icon" aria-hidden="true">☾</span>
      </button>
    </div>
  );
}

/** Shared appearance controls for the regular shell and fullscreen routes. */
export function AppearanceControls({
  theme,
  onThemeChange,
}: {
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}) {
  return (
    <>
      <ThemeToggle theme={theme} onChange={onThemeChange} />
      <LocaleToggle />
    </>
  );
}
