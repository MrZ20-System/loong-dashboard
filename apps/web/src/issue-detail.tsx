import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AgentChatPanel } from "./agent-chat";
import { fetchIssueDetail } from "./issue-client";
import { MarkdownView } from "./markdown";

/**
 * Issue detail page (plan 1.3, 14, 18.3): stored markdown body in the center
 * and an Issue-scoped Agent chat on the right whose cwd is the repository
 * root. Nothing is auto-injected into the prompt (plan 13.6); the GitHub link
 * is provided for the user to reference.
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
      <div className="page-heading">
        <div>
          <p className="eyebrow">{repositoryId} · Issue #{issue.number}</p>
          <h2 id="issue-title">{issue.title}</h2>
          <p className="pr-meta">
            by {issue.authorLogin ?? "unknown"} · {issue.status} · {issue.commentsCount} comments · updated {issue.updatedAt}
          </p>
        </div>
        <div className="pr-heading-actions">
          <a href={issue.url} target="_blank" rel="noreferrer">Open on GitHub</a>
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>Back to list</Link>
        </div>
      </div>
      <div className="issue-layout">
        <div className="issue-body">
          {issue.detailBody !== null && issue.detailBody.length > 0 ? (
            <MarkdownView text={issue.detailBody} />
          ) : (
            <p role="status">This issue has no stored body.</p>
          )}
        </div>
        <AgentChatPanel
          scope={{ kind: "issue", repositoryId, issueNumber: issue.number }}
          heading="Issue chat"
        />
      </div>
    </section>
  );
}
