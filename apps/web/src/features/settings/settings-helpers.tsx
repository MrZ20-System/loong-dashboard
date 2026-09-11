import { useI18n } from "../../i18n";

export function ErrorText({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <p role="alert" className="settings-error">
      {t({ en: "Error:", "zh-CN": "错误：" })} {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
