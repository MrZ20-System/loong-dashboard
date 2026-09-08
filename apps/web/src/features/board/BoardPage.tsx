import { useNavigate } from "react-router-dom";
import { useRepositories } from "../../app/hooks";
import type { RepositorySummary } from "../../metadata-client";
import { HealthStatus } from "../system/HealthStatus";

function RepositorySelector({
  repositories,
  selectedId,
}: {
  repositories: RepositorySummary[];
  selectedId?: string;
}) {
  const navigate = useNavigate();
  const selected = selectedId ?? repositories[0]?.id;
  return (
    <label className="repository-selector">
      Repository
      <select
        aria-label="Repository"
        value={selected ?? ""}
        onChange={(event) =>
          navigate(`/repositories/${encodeURIComponent(event.target.value)}`)
        }
      >
        {repositories.map((repository) => (
          <option key={repository.id} value={repository.id}>
            {repository.displayName} ({repository.githubOwner}/{repository.githubName})
          </option>
        ))}
      </select>
    </label>
  );
}

function RepositoryPicker() {
  const repositories = useRepositories();
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError)
    return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (repositories.data.items.length === 0)
    return <p role="status">No configured repositories.</p>;
  return (
    <RepositorySelector repositories={repositories.data.items} />
  );
}

function RepositoryDashboard() {
  const repositories = useRepositories();
  if (repositories.data === undefined || repositories.data.items.length === 0)
    return null;
  return (
    <div className="repository-board" aria-label="Configured repositories">
      <header>
        <p className="eyebrow">Repositories</p>
        <h3>Repository overview</h3>
      </header>
      <div className="repository-board__grid">
        {repositories.data.items.map((repository) => (
          <article key={repository.id} className="repository-board__card">
            <header>
              <span className="repository-board__mark" aria-hidden="true">
                {repository.displayName.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <h4>{repository.displayName}</h4>
                <p>
                  {repository.githubOwner}/{repository.githubName}
                </p>
              </div>
            </header>
          </article>
        ))}
      </div>
    </div>
  );
}

export function BoardPage() {
  return (
    <section className="home-page" aria-labelledby="welcome-heading">
      <div className="welcome-panel">
        <div className="welcome-panel__copy">
          <p className="eyebrow">Local-first engineering workspace</p>
          <h2 id="welcome-heading">
            A clear view of your repositories and knowledge.
          </h2>
          <p className="welcome-panel__lead">
            LoongBoard brings local Git workspaces, durable Markdown knowledge,
            and coding-agent sessions together in one focused board.
          </p>
        </div>
        <RepositoryPicker />
      </div>
      <RepositoryDashboard />
      <HealthStatus />
    </section>
  );
}
