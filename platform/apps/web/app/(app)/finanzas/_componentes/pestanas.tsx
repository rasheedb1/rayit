import Link from "next/link";
import { can, type Permiso } from "@mc/core";
import { MESSAGES } from "../_lib/messages";

/**
 * Las vistas de Finanzas, en el orden en que se usan, cada una con el
 * permiso que pide su página.
 *
 * El flujo de caja (FIN-6) y los ingresos (FIN-7) llegaron como botones
 * en la cabecera de /finanzas, que era el único sitio que había antes
 * de que FIN-3 trajera esta tira. Viven aquí porque son VISTAS del
 * módulo con su propia URL, no acciones: apilar botones junto a «Nueva
 * factura» mezclaba las dos cosas y a 400 px dejaba cuatro botones
 * sobre el título.
 *
 * El permiso de cada pestaña es EL MISMO que la página comprueba con
 * requirePagePermission (o, para las dos primeras, el mínimo del
 * módulo, que ya exige el layout): una pestaña visible que lleva a un
 * 404 promete lo que no cumple. pestanas.test.tsx lo cruza con cada
 * page.tsx.
 */
export const MODULE_LINKS: readonly { href: string; label: string; permiso: Permiso }[] = [
  { href: "/finanzas", label: MESSAGES.tabs.cobros, permiso: "finanzas.factura.ver" },
  { href: "/finanzas/facturas", label: MESSAGES.tabs.facturas, permiso: "finanzas.factura.ver" },
  { href: "/finanzas/gastos", label: MESSAGES.tabs.gastos, permiso: "finanzas.gasto.ver" },
  { href: "/finanzas/flujo", label: MESSAGES.tabs.flujo, permiso: "finanzas.flujo.ver" },
  // FIN-7 reutiliza finanzas.flujo.ver: lo que pagan las plataformas es
  // una línea del flujo (docs/propuestas/FIN-7.md §1.2).
  { href: "/finanzas/ingresos", label: MESSAGES.tabs.ingresos, permiso: "finanzas.flujo.ver" },
  { href: "/finanzas/configuracion", label: MESSAGES.tabs.configuracion, permiso: "finanzas.ajustes.configurar" },
];

/**
 * La tira de navegación del módulo, como la de Ventas. Son enlaces, no
 * botones: cada vista tiene su URL, se puede compartir y el botón de
 * atrás hace lo que se espera. `aria-current="page"` es lo que un lector
 * de pantalla anuncia; el color solo lo acompaña.
 *
 * Recibe los permisos de la sesión en vez de pedirlos: la página ya los
 * tiene (permisosDeLaSesion va en `cache` de React) y así el componente
 * es síncrono y se prueba sin sesión. Quien no tiene el permiso de una
 * vista no ve su pestaña.
 */
export function ModuleTabs({ active, permisos }: { active: string; permisos: ReadonlySet<Permiso> }) {
  return (
    <nav aria-label={MESSAGES.tabs.label} className="mb-6 flex flex-wrap gap-1.5 border-b border-border pb-px">
      {MODULE_LINKS.filter((link) => can(permisos, link.permiso)).map((link) => {
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
