import { useDomains } from "../../app/hooks";
import { message } from "../../i18n";
import { FilterDropdown } from "../filters/FilterDropdown";

const domainMessages = {
  label: message("Domains", "领域"),
  emptyLabel: message("All domains", "全部领域"),
} as const;

export function DomainFilter({
  repositoryId,
  selected,
  onChange,
}: {
  repositoryId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const domains = useDomains(repositoryId);
  const items = domains.data?.items ?? [];
  if (domains.isPending || domains.isError || items.length === 0) return null;
  return (
    <FilterDropdown
      label={domainMessages.label}
      emptyLabel={domainMessages.emptyLabel}
      multiple
      selected={selected}
      onChange={onChange}
      options={items.map((rule) => ({
        value: rule.id,
        label: rule.name,
        description:
          rule.includePatterns.length > 0
            ? rule.includePatterns.join(" · ")
            : undefined,
      }))}
    />
  );
}
