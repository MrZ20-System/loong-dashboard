import type { DomainTag } from "@loongboard/contracts";

export function DomainChips({ domains }: { domains: DomainTag[] }) {
  if (domains.length === 0) return null;
  return (
    <span className="domain-chips">
      {domains.map((tag) => (
        <span
          key={tag.id}
          className="domain-chip"
          style={{ backgroundColor: tag.color }}
        >
          {tag.name}
        </span>
      ))}
    </span>
  );
}
