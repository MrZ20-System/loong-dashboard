import { HealthStatus } from "./HealthStatus";

export function HealthPage() {
  return (
    <section className="plain-page" aria-labelledby="health-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">System</p>
          <h2 id="health-heading">Service health</h2>
        </div>
      </div>
      <div className="plain-page__card">
        <p className="page-subtitle">
          The web shell checks the API boundary without hiding failures.
        </p>
        <HealthStatus />
      </div>
    </section>
  );
}
