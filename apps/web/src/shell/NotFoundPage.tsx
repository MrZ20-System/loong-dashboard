import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="plain-page" aria-labelledby="not-found-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Not found</p>
          <h2 id="not-found-heading">This LoongBoard route does not exist.</h2>
        </div>
      </div>
      <div className="plain-page__card">
        <Link className="text-link" to="/">
          Return to the board
        </Link>
      </div>
    </section>
  );
}
