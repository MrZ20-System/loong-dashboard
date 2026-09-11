import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectLocale,
  formatDate,
  formatNumber,
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  LocaleToggle,
  message,
  useI18n,
} from ".";

function Probe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <p>{t(message("Hello {name}", "你好，{name}"), { name: "Repository" })}</p>
      <LocaleToggle />
      <button type="button" onClick={() => setLocale("zh-CN")}>Set Chinese</button>
    </div>
  );
}

describe("locale foundation", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    document.documentElement.lang = "en";
  });

  it("detects Chinese browser language and lets a stored locale take precedence", () => {
    const originalLanguage = navigator.language;
    try {
      Object.defineProperty(navigator, "language", { configurable: true, value: "zh-CN" });
      expect(detectLocale()).toBe("zh-CN");
      window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
      expect(detectLocale()).toBe("en");
    } finally {
      Object.defineProperty(navigator, "language", { configurable: true, value: originalLanguage });
    }
  });

  it("persists the selected locale, updates document language, and interpolates only values", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByText("Hello Repository")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "Chinese" }));
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(screen.getByText("你好，Repository")).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("uses the locale for number and date presentation while keeping format inputs stable", () => {
    expect(formatNumber("zh-CN", 1234567)).toBe("1,234,567");
    expect(formatDate("zh-CN", "2026-09-10T12:00:00.000Z", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }, "UTC")).toContain("2026");
  });
});
