import { Link } from "react-router-dom";
import { useI18n } from "../i18n";
import { shellMessages } from "./messages";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <section className="plain-page" aria-labelledby="not-found-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t(shellMessages.notFound)}</p>
          <h2 id="not-found-heading">{t(shellMessages.routeDoesNotExist)}</h2>
        </div>
      </div>
      <div className="plain-page__card">
        <Link className="text-link" to="/">
          {t(shellMessages.returnToBoard)}
        </Link>
      </div>
    </section>
  );
}
