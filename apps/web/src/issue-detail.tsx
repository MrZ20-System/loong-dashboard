import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AgentChatPanel } from "./agent-chat";
import { fetchIssueDetail } from "./issue-client";
import { MarkdownView } from "./markdown";

/**
 * Issue detail page (plan 1.3, 14, 18.3, 7.9): cached markdown body and
 * comments fetched on demand from GitHub, with an Issue-scoped Agent chat
 * on the right whose cwd is the repository root. Nothing is auto-injected
 * into the prompt (plan 13.6); the GitHub links are provided for reference.
 */
export function IssueDetailPage() {
  const { repositoryId = "", number: rawNumber = "" } = useParams();
  const number = Number(rawNumber);
  const enabled = repositoryId.length > 0 && Number.isInteger(number) && number > 0;

  const detail = useQuery({
    queryKey: ["issue", repositoryId, number],
    enabled,
    queryFn: ({ signal }) => {
      void signal;
      return fetchIssueDetail(repositoryId, number);
    },
  });

  if (!enabled) return <p role="alert">Invalid issue number.</p>;
  if (detail.isPending) return <p role="status">Loading issue…</p>;
  if (detail.isError) {
    return (
      <section>
        <h2>Issue unavailable</h2>
        <p role="alert">{detail.error.message}</p>
        <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>Back to issues</Link>
      </section>
    );
  }
  const issue = detail.data;
  return (
    <section className="issue-detail" aria-labelledby="issue-title">
      <div className="page-heading issue-heading">
        <div className="issue-heading__summary">
          <p className="eyebrow">{repositoryId}</p>
          <h2 id="issue-title">
            {issue.title}{" "}
            <a
              className="pr-number-link"
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open issue #${issue.number} on GitHub`}
            >
              #{issue.number}
            </a>
          </h2>
          <p className="pr-meta pr-meta--github">
            <span className={`pr-status-pill pr-status-pill--${issue.status}`}>
              {issue.status}
            </span>
            <strong>{issue.authorLogin ?? "unknown"}</strong>
            <span>opened this issue</span>
            <span className="pr-updated">{issue.createdAt}</span>
            <span aria-hidden="true">·</span>
            <span>{issue.commentsCount} comments</span>
            <span aria-hidden="true">·</span>
            <span className="pr-updated">updated {issue.updatedAt}</span>
          </p>
        </div>
        <div className="pr-heading-actions">
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>Back to list</Link>
        </div>
      </div>
      <div className="issue-layout">
        <div>
          <div className="issue-body">
            {issue.detailBody !== null && issue.detailBody.length > 0 ? (
              <MarkdownView text={issue.detailBody} />
            ) : (
              <p role="status">This issue has no stored body.</p>
            )}
          </div>
          <section className="issue-comments" aria-labelledby="issue-comments-heading">
            <h3 id="issue-comments-heading">Comments</h3>
            {issue.comments.length === 0 ? (
              <p role="status">No comments yet.</p>
            ) : (
              <ol className="issue-comment-list">
                {issue.comments.map((comment) => (
                  <li key={comment.id} className="issue-comment">
                    <p className="issue-comment-meta">
                      <strong>{comment.authorLogin ?? "unknown"}</strong>
                      {" · created "}
                      {comment.createdAt}
                      {" · updated "}
                      {comment.updatedAt}
                      {" · "}
                      <a href={comment.url} target="_blank" rel="noreferrer">
                        GitHub
                      </a>
                    </p>
                    <MarkdownView text={comment.body} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        <AgentChatPanel
          scope={{ kind: "issue", repositoryId, issueNumber: issue.number }}
          heading="Issue chat"
        />
      </div>
    </section>
  );
}
