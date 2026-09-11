import { i18nMessages, useI18n, type Locale } from ".";

export function LocaleToggle() {
  const { locale, setLocale, t } = useI18n();
  const selectLocale = (nextLocale: Locale) => setLocale(nextLocale);
  return (
    <div className="locale-toggle" role="group" aria-label={t(i18nMessages.language)}>
      <button
        type="button"
        className={locale === "zh-CN" ? "locale-toggle__item locale-toggle__item--active" : "locale-toggle__item"}
        aria-label={t(i18nMessages.chinese)}
        aria-pressed={locale === "zh-CN"}
        onClick={() => selectLocale("zh-CN")}
      >
        中文
      </button>
      <button
        type="button"
        className={locale === "en" ? "locale-toggle__item locale-toggle__item--active" : "locale-toggle__item"}
        aria-label={t(i18nMessages.english)}
        aria-pressed={locale === "en"}
        onClick={() => selectLocale("en")}
      >
        EN
      </button>
    </div>
  );
}
