import Link from "next/link";
import { MESSAGES } from "../_lib/messages";
import { MODULE_LINKS } from "../_lib/estado";
import { TiraPestanas } from "./tira-pestanas";

/**
 * La tira de navegación del módulo. Son enlaces, no botones: cada vista
 * tiene su URL, se puede compartir y el botón de atrás hace lo que se
 * espera. `aria-current="page"` es lo que un lector de pantalla
 * anuncia; el color solo lo acompaña. En un teléfono la tira no se
 * parte: se desplaza por dentro (TiraPestanas) y trae la activa a la vista.
 *
 * Desde lg (una pantalla de 1280 px con la barra lateral deja 944 px) el
 * relleno y la separación se estrechan (lg:px-2, lg:gap-0.5 en la tira):
 * con los de sm, las once pestañas medían unos 977 px en Geist 14 px y
 * «Brief» quedaba cortado bajo el degradado; así miden unos 850 px y
 * caben enteras, con holgura para la activa en negrita (pulido r3).
 */
export function ModuleTabs({ active }: { active: string }) {
  return (
    <TiraPestanas label={MESSAGES.tabs.label}>
      {MODULE_LINKS.map((link) => {
        const on = link.href === active;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm transition-colors sm:px-3 lg:px-2 ${
              on ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </TiraPestanas>
  );
}
