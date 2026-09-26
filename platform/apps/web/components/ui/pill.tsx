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

/**
 * Estado corto con punto de color, como el mock (`.pill`).
 *
 * El texto va en su propio span con `truncate` (VEN-7 r4): una Pill con
 * `max-w-*` en className corta el texto largo con «…» en vez de salirse
 * de la tarjeta a 400 px. Sin tope no cambia nada. El texto entero sigue
 * en el DOM (el lector de pantalla lo lee completo); quien la usa puede
 * darle un `title` al contenedor para verlo al pasar el ratón.
 */
export function Pill({ kind, children, className = "" }: PillProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium ${KIND[kind]} ${className}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
