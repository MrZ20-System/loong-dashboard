import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "zh-CN";

export type LocalizedMessage = {
  en: string;
  "zh-CN": string;
};

export type MessageValue = string | number | boolean | null | undefined;
export type MessageValues = Record<string, MessageValue>;

export const LOCALE_STORAGE_KEY = "loongboard.locale";

export function message(en: string, zhCN: string): LocalizedMessage {
  return { en, "zh-CN": zhCN };
}

function interpolate(template: string, values: MessageValues | undefined): string {
  if (values === undefined) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? placeholder : String(value);
  });
}

export function translate(
  locale: Locale,
  localizedMessage: LocalizedMessage,
  values?: MessageValues,
): string {
  return interpolate(localizedMessage[locale], values);
}

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "zh-CN";
}

export function detectLocale(): Locale {
  try {
    if (typeof window !== "undefined") {
      const stored = window.localStorage?.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) return stored;
    }
  } catch {
    // Browser storage can be disabled; fall back to the browser language.
  }
  const language = typeof navigator === "undefined" ? "" : navigator.language;
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatWithOptions(
  locale: Locale,
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string,
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(locale, options).format(date);
    } catch {
      return String(value);
    }
  }
}

export function formatNumber(locale: Locale, value: number): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function formatDate(
  locale: Locale,
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
  timeZone?: string,
): string {
  return formatWithOptions(locale, value, options, timeZone);
}

export function formatDateTime(
  locale: Locale,
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
  timeZone?: string,
): string {
  return formatWithOptions(locale, value, options, timeZone);
}

export function formatTime(
  locale: Locale,
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  },
  timeZone?: string,
): string {
  return formatWithOptions(locale, value, options, timeZone);
}

const commonMessages = {
  language: message("Language", "语言"),
  chinese: message("Chinese", "中文"),
  english: message("English", "英语"),
} as const;

export const i18nMessages = commonMessages;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (localizedMessage: LocalizedMessage, values?: MessageValues) => string;
  formatNumber: (value: number) => string;
  formatDate: (
    value: DateInput,
    options?: Intl.DateTimeFormatOptions,
    timeZone?: string,
  ) => string;
  formatDateTime: (
    value: DateInput,
    options?: Intl.DateTimeFormatOptions,
    timeZone?: string,
  ) => string;
  formatTime: (
    value: DateInput,
    options?: Intl.DateTimeFormatOptions,
    timeZone?: string,
  ) => string;
}

const defaultContext: I18nContextValue = {
  locale: "en",
  setLocale: () => undefined,
  t: (localizedMessage, values) => translate("en", localizedMessage, values),
  formatNumber: (value) => formatNumber("en", value),
  formatDate: (value, options, timeZone) => formatDate("en", value, options, timeZone),
  formatDateTime: (value, options, timeZone) => formatDateTime("en", value, options, timeZone),
  formatTime: (value, options, timeZone) => formatTime("en", value, options, timeZone),
};

const I18nContext = createContext<I18nContextValue>(defaultContext);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Browser storage can be disabled; the current session still works.
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (localizedMessage, values) => translate(locale, localizedMessage, values),
      formatNumber: (number) => formatNumber(locale, number),
      formatDate: (date, options, timeZone) => formatDate(locale, date, options, timeZone),
      formatDateTime: (date, options, timeZone) => formatDateTime(locale, date, options, timeZone),
      formatTime: (time, options, timeZone) => formatTime(locale, time, options, timeZone),
    }),
    [locale, setLocale],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export { LocaleToggle } from "./LocaleToggle";
