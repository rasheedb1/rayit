import type { ReactNode } from "react";
import { MobileNav, SideNav } from "./nav";
import { ThemeToggle } from "./theme-toggle";
// CIM-3: el selector de espacio. Se monta en una línea aquí y en la
// cabecera móvil; todo lo suyo (datos, menú, acciones) vive en
// components/workspace-switcher.tsx.
import { WorkspaceSwitcher } from "./workspace-switcher";
import { Marca } from "./marca";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";

// CIM-3: la marca es una sola, la de components/marca.tsx (también la usan /login y /legal).
const Brand = () => <Marca enMarco />;

/**
 * ACC-5: los permisos de quien mira se resuelven aquí, en servidor, y
 * bajan a la navegación (cliente) como lista. Es la misma lectura que
 * hacen el layout del módulo y las Server Actions: `cache` de React la
 * memoriza por petición.
 *
 * Si la base no contesta, el menú se queda sin módulos y la pantalla
 * cae en su error.tsx: un marco no puede tumbar todas las rutas por una
 * consulta (mismo criterio que el selector de espacio). Nunca se
 * concede «por si acaso».
 */
async function permisosDelMarco(): Promise<readonly string[]> {
  try {
    return [...(await permisosDeLaSesion())];
  } catch (err) {
    console.error("[permisos] no se pudieron leer los permisos de la sesión para el marco", err);
    return [];
  }
}

export async function Shell({ children }: { children: ReactNode }) {
  const permisos = await permisosDelMarco();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <aside aria-label="Barra lateral" className="hidden border-r border-line bg-bg-2 md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="flex h-14 items-center justify-between px-4">
          <Brand />
          <ThemeToggle />
        </div>
        <WorkspaceSwitcher />
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <SideNav permisos={permisos} />
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
          <MobileNav permisos={permisos} />
        </header>
        <main className="mx-auto w-full max-w-5xl px-4 py-8 md:px-10 md:py-12">{children}</main>
      </div>
    </div>
  );
}
