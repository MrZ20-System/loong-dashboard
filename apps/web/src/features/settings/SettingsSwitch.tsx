import type { ChangeEvent, ReactNode } from "react";

export interface SettingsSwitchProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Accessible, deliberately small switch primitive shared by Settings pages. */
export function SettingsSwitch({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  className = "",
}: SettingsSwitchProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked);
  return (
    <label className={`settings-switch ${className}`.trim()}>
      <span className="settings-switch__control">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={handleChange}
        />
        <span className="settings-switch__track" aria-hidden="true"><span className="settings-switch__thumb" /></span>
      </span>
      <span className="settings-switch__copy">
        <strong>{label}</strong>
        {description !== undefined && <small>{description}</small>}
      </span>
    </label>
  );
}
