import { useId } from "react";
import { useI18n } from "../../i18n";

export const CRON_EXAMPLE_VALUES = [
  "*/30 * * * *",
  "0 */6 * * *",
  "0 3 * * *",
  "0 3 * * 1",
  "0 3 1 * *",
] as const;

interface CronFieldProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  defaultValue: string;
  disabled?: boolean;
}

/** A deliberately small five-field Cron editor shared by every settings card. */
export function CronField({ id, label, value, onChange, defaultValue, disabled = false }: CronFieldProps) {
  const { t } = useI18n();
  const generatedId = useId();
  const fieldId = id ?? `cron-${generatedId}`;
  const helpId = `${fieldId}-help`;
  return (
    <div className="settings-cron-field">
      <label htmlFor={fieldId}>
        {label}
        <input
          id={fieldId}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={defaultValue}
          aria-describedby={helpId}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          disabled={disabled}
        />
      </label>
      <p id={helpId} className="settings-muted">
        {t(
          {
            en: "Five-field Cron. Examples: {examples}. The enabled switch controls whether this schedule runs.",
            "zh-CN": "五字段 Cron。示例：{examples}。启用开关独立控制是否运行此计划。",
          },
          { examples: CRON_EXAMPLE_VALUES.join(", ") },
        )}
      </p>
    </div>
  );
}
