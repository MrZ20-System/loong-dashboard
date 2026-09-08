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
  return (
    (/^\d+$/.test(numberNeedle) && String(item.number) === numberNeedle) ||
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
}: {
  kind: MetadataKind;
  items: MetadataListItem[];
}) {
  const navigate = useNavigate();
  if (items.length === 0) return null;

  const singular = kind === "pulls" ? "Pull request" : "Issue";
  const externalLabel = kind === "pulls" ? "pull request" : "issue";

  return (
    <ul
      className="feed-list"
      aria-label={kind === "pulls" ? "Pull request feed" : "Issue feed"}
    >
      {items.map((item) => {
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
      })}
    </ul>
  );
}
