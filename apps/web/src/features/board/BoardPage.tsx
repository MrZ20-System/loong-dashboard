import { useNavigate } from "react-router-dom";
import { useRepositories } from "../../app/hooks";
import type { RepositorySummary } from "../../metadata-client";
import { useI18n } from "../../i18n";
import { HealthStatus } from "../system/HealthStatus";
import { boardMessages } from "./messages";

function RepositorySelector({
  repositories,
  selectedId,
}: {
  repositories: RepositorySummary[];
  selectedId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const selected = selectedId ?? repositories[0]?.id;
  return (
    <label className="repository-selector">
      {t(boardMessages.repository)}
      <select
        aria-label={t(boardMessages.repository)}
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
  const { t } = useI18n();
  const repositories = useRepositories();
  if (repositories.isPending) return <p role="status">{t(boardMessages.loadingRepositories)}</p>;
  if (repositories.isError)
    return <p role="alert">{t(boardMessages.unableLoadRepositories, { detail: repositories.error.message })}</p>;
  if (repositories.data.items.length === 0)
    return <p role="status">{t(boardMessages.noConfiguredRepositories)}</p>;
  return (
    <RepositorySelector repositories={repositories.data.items} />
  );
}

function RepositoryDashboard() {
  const { t } = useI18n();
  const repositories = useRepositories();
  if (repositories.data === undefined || repositories.data.items.length === 0)
    return null;
  return (
    <div className="repository-board" aria-label={t(boardMessages.configuredRepositories)}>
      <header>
        <p className="eyebrow">{t(boardMessages.repositories)}</p>
        <h3>{t(boardMessages.repositoryOverview)}</h3>
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
  const { t } = useI18n();
  return (
    <section className="home-page" aria-labelledby="welcome-heading">
      <div className="welcome-panel">
        <div className="welcome-panel__copy">
          <p className="eyebrow">{t(boardMessages.localFirstWorkspace)}</p>
          <h2 id="welcome-heading">{t(boardMessages.clearView)}</h2>
          <p className="welcome-panel__lead">{t(boardMessages.lead)}</p>
        </div>
        <RepositoryPicker />
      </div>
      <RepositoryDashboard />
      <HealthStatus />
    </section>
  );
}
