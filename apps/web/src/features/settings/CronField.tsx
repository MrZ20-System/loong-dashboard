import { useId } from "react";
import { message, useI18n } from "../../i18n";

export const CRON_HELP_MESSAGE = message(
  "The five fields are minute, hour, day of month, month, and day of week. * means every value; */30 means every 30 units (every 30 minutes in the minute field). The switch controls whether the schedule runs.",
  "五个字段依次为分钟、小时、日、月、星期。* 表示任意值；*/30 表示每 30 个单位执行一次（用于分钟字段时即每 30 分钟）。开关决定是否运行此计划。",
);

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
        {t(CRON_HELP_MESSAGE)}
      </p>
    </div>
  );
}
