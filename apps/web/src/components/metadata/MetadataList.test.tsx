import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  matchesMetadataSearch,
  MetadataFeed,
} from "./MetadataList";
import { FilterBar } from "../../features/community/MetadataPage";
import type {
  IssueListItem,
  PullRequestListItem,
} from "../../metadata-client";

const pull = (overrides: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
  repositoryId: "repo",
  number: 53906,
  title: "Add scheduler observability",
  url: "https://github.com/acme/project/pull/53906",
  authorLogin: "AliceBuilder",
  status: "open",
  updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 1,
  additions: 2,
  deletions: 0,
  domains: [],
  ...overrides,
});

const issue = (overrides: Partial<IssueListItem> = {}): IssueListItem => ({
  repositoryId: "repo",
  number: 53906,
  title: "Track scheduler observability",
  url: "https://github.com/acme/project/issues/53906",
  authorLogin: "IssueBuilder",
  status: "open",
  updatedAt: "2026-09-03T02:03:04.000Z",
  commentsCount: 1,
  ...overrides,
});

describe("metadata list controls", () => {
  it("keeps date range, search, and status in one metadata toolbar contract", () => {
    render(
      <MemoryRouter>
        <FilterBar
          kind="pulls"
          from={null}
          to={null}
          status={null}
          search=""
          onDateRange={() => undefined}
          onStatus={() => undefined}
          onSearch={() => undefined}
        />
      </MemoryRouter>,
    );

    const toolbar = screen.getByRole("form", { name: "Metadata filters" });
    expect(toolbar).toHaveClass("filters", "metadata-filters");
    expect(toolbar.querySelector(".date-day-filter")).not.toBeNull();
    expect(toolbar.querySelector(".search-filter input")).not.toBeNull();
    expect(toolbar.querySelector(".filter-dropdown")).not.toBeNull();
  });

  it("matches PR and issue numbers by normalized numeric substrings", () => {
    expect(matchesMetadataSearch(pull(), "53906")).toBe(true);
    expect(matchesMetadataSearch(pull(), "#53906")).toBe(true);
    expect(matchesMetadataSearch(pull(), "390")).toBe(true);
    expect(matchesMetadataSearch(issue(), "#390")).toBe(true);
    expect(matchesMetadataSearch(pull({ number: 12_345 }), "390")).toBe(false);
  });

  it("matches title and author by case-insensitive contiguous substrings", () => {
    expect(matchesMetadataSearch(pull(), "heduler ob")).toBe(true);
    expect(matchesMetadataSearch(pull(), "builder")).toBe(true);
    expect(matchesMetadataSearch(issue(), "k scheduler o")).toBe(true);
    expect(matchesMetadataSearch(issue(), "builder")).toBe(true);
    expect(matchesMetadataSearch(pull(), "scheduler observability")).toBe(true);
    expect(matchesMetadataSearch(pull(), "observability scheduler")).toBe(false);
  });

  it("keeps metadata status variants as semantic status classes", () => {
    render(
      <MemoryRouter>
        <MetadataFeed
          kind="pulls"
          items={[
            pull({ number: 1, status: "open" }),
            pull({ number: 2, status: "draft" }),
            pull({ number: 3, status: "merged" }),
            pull({ number: 4, status: "closed" }),
          ]}
        />
      </MemoryRouter>,
    );

    for (const status of ["open", "draft", "merged", "closed"] as const) {
      expect(screen.getByText(status)).toHaveClass(
        "status-pill",
        `status-${status}`,
      );
    }
  });
});
