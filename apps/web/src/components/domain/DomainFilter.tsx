import { useDomains } from "../../app/hooks";
import { FilterDropdown } from "../filters/FilterDropdown";

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
      label="Domains"
      emptyLabel="All domains"
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
