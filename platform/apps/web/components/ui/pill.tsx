export type PillKind = "good" | "warn" | "bad" | "neutral";

export interface PillProps {
  kind: PillKind;
  /** Texto obligatorio: el color nunca es el único indicador. */
  children: string;
  className?: string;
}

const KIND: Record<PillKind, string> = {
  good: "border-transparent bg-ok-bg text-ok",
  warn: "border-transparent bg-warn-bg text-warn",
  bad: "border-transparent bg-danger-bg text-danger",
  neutral: "border-line bg-bg text-fg-2",
};

/** Pastilla de estado: punto de color + texto. Server Component. */
export function Pill({ kind, children, className = "" }: PillProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${KIND[kind]} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
