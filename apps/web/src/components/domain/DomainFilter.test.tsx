import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDomains } from "../../app/hooks";
import { LocaleProvider, useI18n } from "../../i18n";
import { DomainFilter } from "./DomainFilter";

vi.mock("../../app/hooks", () => ({
  useDomains: vi.fn(),
}));

const domain = {
  id: "dom_frontend",
  repositoryId: "repo",
  name: "Frontend API",
  color: "#5b8def",
  position: 0,
  enabled: true,
  includePatterns: ["src/**", "api/**"],
  excludePatterns: [],
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function ChineseLocale({ children }: PropsWithChildren) {
  const { setLocale } = useI18n();
  useEffect(() => setLocale("zh-CN"), [setLocale]);
  return children;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DomainFilter", () => {
  it("translates fixed labels while preserving dynamic Domain names and patterns", async () => {
    vi.mocked(useDomains).mockReturnValue({
      data: { items: [domain] },
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useDomains>);

    render(
      <LocaleProvider>
        <ChineseLocale>
          <DomainFilter repositoryId="repo" selected={[]} onChange={vi.fn()} />
        </ChineseLocale>
      </LocaleProvider>,
    );

    const trigger = await screen.findByRole("button", { name: /领域 全部领域/ });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByText("Domains")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "领域选项" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: /Frontend API/ })).toBeInTheDocument();
    expect(screen.getByText("src/** · api/**")).toBeInTheDocument();
  });
});
