import { useEffect, useRef, useState } from "react";

export interface FilterDropdownOption {
  value: string;
  label: string;
  description?: string;
}

function summaryLabel(
  selected: string[],
  options: FilterDropdownOption[],
  multiple: boolean,
  emptyLabel: string,
) {
  if (selected.length === 0) return emptyLabel;
  if (!multiple) {
    return options.find((option) => option.value === selected[0])?.label ??
      selected[0];
  }
  if (selected.length === 1) {
    return options.find((option) => option.value === selected[0])?.label ??
      selected[0];
  }
  return `${selected.length} selected`;
}

export function FilterDropdown({
  label,
  emptyLabel,
  options,
  selected,
  onChange,
  multiple = false,
}: {
  label: string;
  emptyLabel: string;
  options: FilterDropdownOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const selectedIndexes = selected
    .map((value) => options.findIndex((option) => option.value === value))
    .filter((index) => index >= 0);
  const summary = summaryLabel(selected, options, multiple, emptyLabel);

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

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="filter-dropdown__trigger"
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
        <span className="filter-dropdown__trigger-copy">
          <small>{label}</small>
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
          aria-label={`${label} options`}
          aria-multiselectable={multiple || undefined}
        >
          <div className="filter-dropdown__menu-heading">
            <strong>{label}</strong>
            <span>
              {selected.length > 0 ? `${selected.length} selected` : "No selection"}
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
                  <span className="filter-dropdown__check" aria-hidden="true">
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className="filter-dropdown__option-copy">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
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
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
