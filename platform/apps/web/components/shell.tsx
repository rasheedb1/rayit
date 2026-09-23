import type { ReactNode } from "react";
import { MobileNav, SideNav } from "./nav";
import { ThemeToggle } from "./theme-toggle";
// CIM-3: el selector de espacio. Se monta en una línea aquí y en la
// cabecera móvil; todo lo suyo (datos, menú, acciones) vive en
// components/workspace-switcher.tsx.
import { WorkspaceSwitcher } from "./workspace-switcher";
import { Marca } from "./marca";

// CIM-3: la marca es una sola, la de components/marca.tsx (también la usan /login y /legal).
const Brand = () => <Marca enMarco />;

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <aside aria-label="Barra lateral" className="hidden border-r border-line bg-bg-2 md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="flex h-14 items-center justify-between px-4">
          <Brand />
          <ThemeToggle />
        </div>
        <WorkspaceSwitcher />
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <SideNav />
        </div>
        <div className="border-t border-line px-4 py-3">
          <p className="text-[11px] leading-4 text-fg-3">MVP · fase 1</p>
          <p className="text-[11px] leading-4 text-fg-3">Resumen, Ventas, Cotizar, Campañas, Finanzas y Conexiones</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 border-b border-line bg-bg md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <Brand />
            <ThemeToggle />
          </div>
          <WorkspaceSwitcher />
          <MobileNav />
        </header>
        <main className="mx-auto w-full max-w-5xl px-4 py-8 md:px-10 md:py-12">{children}</main>
      </div>
    </div>
  );
}
