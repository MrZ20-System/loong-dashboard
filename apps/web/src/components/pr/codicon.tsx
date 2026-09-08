interface CodiconProps {
  /** Monaco codicon name, e.g. `layout-sidebar-left-off`. */
  readonly name: string;
  readonly className?: string;
  readonly label?: string;
}

/**
 * Render a real Monaco Codicon glyph. The font and its codepoint classes are
 * declared in styles.css so no icon framework or network dependency is added.
 * Icons are decorative by default; pass `label` only when the icon itself is
 * the accessible name for a control.
 */
export function Codicon({ name, className, label }: CodiconProps) {
  const classes = [`codicon`, `codicon-${name}`];
  if (className !== undefined) classes.push(className);
  if (label !== undefined) {
    return <span className={classes.join(" ")} role="img" aria-label={label} />;
  }
  return <span className={classes.join(" ")} aria-hidden="true" />;
}
