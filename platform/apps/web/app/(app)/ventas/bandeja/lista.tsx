import Link from "next/link";
import { Pill } from "@/components/ui/pill";
import { MESSAGES } from "./messages";
import type { HiloVista } from "./vista";

const t = MESSAGES;

/**
 * La lista de conversaciones, a la izquierda: sin leer primero, en negrita
 * y con su punto; después de la más reciente a la más vieja. Cada una es un
 * enlace (la URL lleva la ficha y el canal): se comparte y el botón de
 * atrás hace lo que se espera. La abierta lleva aria-current.
 */
export function ListaHilos({ hilos }: { hilos: HiloVista[] }) {
  return (
    <nav aria-label={t.lista.label}>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border" role="list">
        {hilos.map((h) => (
          <li key={h.key}>
            <Link
              href={h.href}
              aria-current={h.activo ? "page" : undefined}
              className={`block px-3 py-3 transition-colors hover:bg-hover ${h.activo ? "bg-hover" : "bg-surface"}`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className={`flex min-w-0 items-center gap-2 text-sm ${h.sinLeer > 0 ? "font-semibold text-ink" : "text-ink"}`}>
                  {h.sinLeer > 0 ? <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" /> : null}
                  <span className="truncate">{h.persona}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-2">{h.cuando}</span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-ink-2">
                {h.empresa} · {h.canal}
              </span>
              <span className="mt-1 block truncate text-sm text-ink-2">
                {h.deNosotros ? t.lista.tu : ""}
                {h.extracto}
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <Pill kind={t.intenciones[h.intencion].kind}>{t.intenciones[h.intencion].label}</Pill>
                {h.sinLeerTexto ? <span className="sr-only">{h.sinLeerTexto}</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
