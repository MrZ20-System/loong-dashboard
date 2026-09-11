import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type {
  IssueListItem,
  PullRequestListItem,
} from "../../metadata-client";
import { DomainChips } from "../domain/DomainChips";

export type MetadataKind = "pulls" | "issues";
export type MetadataListItem = PullRequestListItem | IssueListItem;

export function matchesMetadataSearch(
  item: MetadataListItem,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  const numberNeedle = needle.startsWith("#") ? needle.slice(1) : needle;
  const numberMatches =
    numberNeedle.length > 0 &&
    /^\d+$/.test(numberNeedle) &&
    String(item.number).includes(numberNeedle);
  return (
    numberMatches ||
    item.title.toLowerCase().includes(needle) ||
    item.authorLogin?.toLowerCase().includes(needle) === true
  );
}

export function MetadataSearchField({
  kind,
  value,
  onChange,
}: {
  kind: MetadataKind;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="search-filter">
      <span>Search</span>
      <input
        type="search"
        aria-label="Search list"
        placeholder={
          kind === "pulls"
            ? "PR number, author, or title"
            : "Issue number, author, or title"
        }
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function isPullRequest(
  kind: MetadataKind,
  item: MetadataListItem,
): item is PullRequestListItem {
  return kind === "pulls";
}

export function MetadataFeed({
  kind,
  items,
  groupByUpdatedDay = false,
  calendarTimeZone = "Asia/Shanghai",
}: {
  kind: MetadataKind;
  items: MetadataListItem[];
  groupByUpdatedDay?: boolean;
  calendarTimeZone?: string;
}) {
  const navigate = useNavigate();
  if (items.length === 0) return null;

  let previousDay: string | null = null;
  const rows: ReactNode[] = [];
  for (const item of items) {
    const day = groupByUpdatedDay ? calendarDay(item.updatedAt, calendarTimeZone) : null;
    if (day !== null && day !== previousDay) {
      rows.push(
        <li className="feed-date-divider" role="separator" key={`date-${day}`}>
          <span>{day}</span>
        </li>,
      );
      previousDay = day;
    }
    rows.push(renderMetadataItem(item, kind, navigate));
  }

  return (
    <ul
      className="feed-list"
      aria-label={kind === "pulls" ? "Pull request feed" : "Issue feed"}
    >
      {rows}
    </ul>
  );
}

function calendarDay(value: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // If the browser cannot construct the formatter, keep rendering the item
    // without a divider.
  }
  return value.slice(0, 10);
}

function renderMetadataItem(
  item: MetadataListItem,
  kind: MetadataKind,
  navigate: ReturnType<typeof useNavigate>,
): ReactNode {
  const singular = kind === "pulls" ? "Pull request" : "Issue";
  const externalLabel = kind === "pulls" ? "pull request" : "issue";
  const detailPath = `/repositories/${encodeURIComponent(item.repositoryId)}/${kind}/${item.number}`;
  return (
          <li
            key={item.number}
            className="feed-row feed-row--interactive"
            role="link"
            tabIndex={0}
            aria-label={`${singular} #${item.number}: ${item.title}`}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a, button, input, select, textarea")
              ) {
                return;
              }
              navigate(detailPath);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(detailPath);
              }
            }}
          >
            <div className="feed-row__rail">
              <a
                className="feed-row__number"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${externalLabel} #${item.number} on GitHub`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                #{item.number}
              </a>
              <span className={`status-pill status-${item.status}`}>
                {item.status}
              </span>
            </div>
            <div className="feed-row__content">
              <div className="feed-row__title-line">
                <h3 className="feed-row__title">{item.title}</h3>
                {isPullRequest(kind, item) && (
                  <DomainChips domains={item.domains} />
                )}
              </div>
              <p className="feed-row__meta">
                <span>{item.authorLogin ?? "Unknown"}</span>
                <span aria-hidden="true">·</span>
                <span>updated {item.updatedAt}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {isPullRequest(kind, item)
                    ? `+${item.additions} −${item.deletions} in ${item.changedFilesCount} files`
                    : `${item.commentsCount} comments`}
                </span>
              </p>
            </div>
          </li>
  );
}
