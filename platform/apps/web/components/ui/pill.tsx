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

export type TruncatedPillProps = PillProps & {
  /** Ancho máximo, como utilidad de Tailwind. Por defecto, 16rem. */
  maxWidth?: string;
};

/**
 * La misma Pill para un texto que puede ser largo (VEN-7 r4: la regla
 * del brief que deja fuera una señal, «Tu brief no acepta a …»): con
 * tope de ancho, corta el texto con «…» por CSS y lo enseña entero en
 * `title`. El texto entero sigue en el DOM, así que el lector de
 * pantalla lo lee completo. Cortar la cadena a mano podía partir un
 * emoji (dos unidades UTF-16).
 *
 * Es un componente aparte y no una opción de Pill: la API de Pill no
 * cambia, y quien parte la frase de una Pill en dos líneas
 * (`whitespace-normal!`) sigue igual.
 */
export function TruncatedPill({ kind, children, className = "", maxWidth = "max-w-[16rem]" }: TruncatedPillProps) {
  return (
    <span
      title={children}
      className={`inline-flex min-w-0 ${maxWidth} items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium ${KIND[kind]} ${className}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
