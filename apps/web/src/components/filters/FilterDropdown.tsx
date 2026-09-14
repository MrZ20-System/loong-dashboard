import { useEffect, useRef, useState } from "react";
import { useI18n, type LocalizedMessage } from "../../i18n";
import { filterMessages } from "./messages";

type LocalizedText = string | LocalizedMessage;

export interface FilterDropdownOption {
  value: string;
  label: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  tone?: "accent" | "blue" | "green" | "neutral" | "orange" | "purple" | "red";
}

function summaryLabel(
  selected: string[],
  options: FilterDropdownOption[],
  multiple: boolean,
  emptyLabel: string,
  fullSelectionLabel: string | undefined,
  localize: (value: LocalizedText) => string,
  formatNumber: (value: number) => string,
) {
  if (selected.length === 0) return emptyLabel;
  if (!multiple) {
    const option = options.find((item) => item.value === selected[0]);
    return option === undefined ? selected[0] : localize(option.label);
  }
  if (fullSelectionLabel !== undefined && selected.length === options.length) {
    return fullSelectionLabel;
  }
  if (selected.length === 1) {
    const option = options.find((item) => item.value === selected[0]);
    return option === undefined ? selected[0] : localize(option.label);
  }
  if (selected.length <= 2) {
    return selected
      .map((value) => options.find((item) => item.value === value))
      .map((option, index) => option === undefined ? selected[index] ?? "" : localize(option.label))
      .filter((value) => value.length > 0)
      .join(", ");
  }
  return localize(filterMessages.selected).replace(
    "{count}",
    formatNumber(selected.length),
  );
}

export function FilterDropdown({
  label,
  emptyLabel,
  options,
  selected,
  onChange,
  multiple = false,
  fullSelectionLabel,
}: {
  label: LocalizedText;
  emptyLabel: LocalizedText;
  options: FilterDropdownOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
  fullSelectionLabel?: LocalizedText;
}) {
  const { t, formatNumber } = useI18n();
  const localize = (value: LocalizedText) => typeof value === "string" ? value : t(value);
  const labelText = localize(label);
  const emptyLabelText = localize(emptyLabel);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const selectedIndexes = selected
    .map((value) => options.findIndex((option) => option.value === value))
    .filter((index) => index >= 0);
  const summary = summaryLabel(
    selected,
    options,
    multiple,
    emptyLabelText,
    fullSelectionLabel === undefined ? undefined : localize(fullSelectionLabel),
    localize,
    formatNumber,
  );

  useEffect(() => {
    if (!open) return;
    if (focusIndex !== null) {
      const nextOption = optionRefs.current[focusIndex];
      nextOption?.focus();
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [focusIndex, open]);

  const openWithFocus = (index: number) => {
    setOpen(true);
    setFocusIndex(index);
  };

  const close = () => {
    setOpen(false);
    setFocusIndex(null);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const anchor =
        selectedIndexes[0] ?? (event.key === "ArrowDown" ? 0 : options.length - 1);
      openWithFocus(anchor);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[index];
      if (option) toggleOption(option.value);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((index + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((index - 1 + options.length) % options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFocusIndex(options.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const toggleOption = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
    onChange(next);
    if (!multiple) close();
  };

  const selectedOption = options.find((option) => option.value === selected[0]);

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={selectedOption?.icon ? "filter-dropdown__trigger filter-dropdown__trigger--with-icon" : "filter-dropdown__trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setFocusIndex(null);
          setOpen(true);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        {selectedOption?.icon && <span className={`filter-dropdown__icon tone-${selectedOption.tone ?? "neutral"}`} aria-hidden="true">{selectedOption.icon}</span>}
        <span className="filter-dropdown__trigger-copy">
          <small>{labelText}</small>
          <strong>{summary}</strong>
        </span>
        <span className="filter-dropdown__chevron" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div
          className="filter-dropdown__menu"
          role="listbox"
          aria-label={t(filterMessages.options, { label: labelText })}
          aria-multiselectable={multiple || undefined}
        >
          <div className="filter-dropdown__menu-heading">
            <strong>{labelText}</strong>
            <span>
              {selected.length > 0
                ? t(filterMessages.selected, { count: formatNumber(selected.length) })
                : t(filterMessages.noSelection)}
            </span>
          </div>
          <div className="filter-dropdown__options">
            {options.map((option, index) => {
              const isSelected = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={isSelected ? "filter-dropdown__option selected" : "filter-dropdown__option"}
                  onClick={() => toggleOption(option.value)}
                  onKeyDown={(event) => moveFocus(event, index)}
                >
                  {option.icon && <span className={`filter-dropdown__option-icon tone-${option.tone ?? "neutral"}`} aria-hidden="true">{option.icon}</span>}
                  <span className="filter-dropdown__check" aria-hidden="true">
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className="filter-dropdown__option-copy">
                    <strong>{localize(option.label)}</strong>
                    {option.description && <small>{localize(option.description)}</small>}
                  </span>
                </button>
              );
            })}
          </div>
          {multiple && (
            <div className="filter-dropdown__footer">
              <button
                type="button"
                disabled={selected.length === 0}
                onClick={() => onChange([])}
              >
                {t(filterMessages.clear)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
