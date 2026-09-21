import type { ReactNode } from "react";
import Link from "next/link";
import { MobileNav, SideNav } from "./nav";
import { ThemeToggle } from "./theme-toggle";

function Brand() {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5 rounded-sm">
      <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-accent-fg" aria-hidden="true">
        M
      </span>
      <span className="text-sm font-semibold tracking-tight">MultiCampaign</span>
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-bg-2 md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="flex h-14 items-center justify-between px-4">
          <Brand />
          <ThemeToggle />
        </div>
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
          <MobileNav />
        </header>
        <main className="mx-auto w-full max-w-5xl px-4 py-8 md:px-10 md:py-12">{children}</main>
      </div>
    </div>
  );
}
