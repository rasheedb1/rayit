export type PillKind = "good" | "warn" | "bad" | "neutral";

export type PillProps = {
  kind: PillKind;
  /** Texto obligatorio: el color nunca es el único indicador. */
  children: string;
  className?: string;
};

const KIND: Record<PillKind, string> = {
  good: "text-good bg-good-wash border-transparent",
  warn: "text-warn bg-warn-wash border-transparent",
  bad: "text-bad bg-bad-wash border-transparent",
  neutral: "text-ink-2 bg-surface border-border",
};

/** Estado corto con punto de color, como el mock (`.pill`). */
export function Pill({ kind, children, className = "" }: PillProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium ${KIND[kind]} ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
