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
        onClick={() => onChange("light")}
      >
        {t(shellMessages.light)}
      </button>
      <button
        type="button"
        className={theme === "dark" ? "theme-toggle__item theme-toggle__item--active" : "theme-toggle__item"}
        aria-pressed={theme === "dark"}
        onClick={() => onChange("dark")}
      >
        {t(shellMessages.dark)}
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
