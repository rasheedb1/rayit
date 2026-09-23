import Link from "next/link";
import { MESSAGES } from "../_lib/messages";

/** Las dos vistas de Finanzas, en el orden en que se usan. */
const MODULE_LINKS = [
  { href: "/finanzas", label: MESSAGES.tabs.cobros },
  { href: "/finanzas/facturas", label: MESSAGES.tabs.facturas },
];

/**
 * La tira de navegación del módulo, como la de Ventas. Son enlaces, no
 * botones: cada vista tiene su URL, se puede compartir y el botón de
 * atrás hace lo que se espera. `aria-current="page"` es lo que un lector
 * de pantalla anuncia; el color solo lo acompaña.
 */
export function ModuleTabs({ active }: { active: string }) {
  return (
    <nav aria-label={MESSAGES.tabs.label} className="mb-6 flex flex-wrap gap-1.5 border-b border-border pb-px">
      {MODULE_LINKS.map((link) => {
        const on = link.href === active;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              on ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
