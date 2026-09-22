"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Handshake,
  Layers,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Palette,
  Plug,
  Receipt,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { flags as defaultFlags, type Flags } from "@/content/flags";
import { isEnabled, moduleBySlug, productModules } from "@/content/modules";
import { OwnerAvatar } from "./owner";

const ICONS: Partial<Record<string, LucideIcon>> = {
  resumen: LayoutDashboard,
  ventas: Handshake,
  cotizar: Receipt,
  campanas: Megaphone,
  finanzas: Wallet,
  conexiones: Plug,
  kit: Palette,
};

type NavItem = { href: string; label: string; icon: LucideIcon };

/** Lo que ve el equipo. La galería del kit solo con su bandera encendida. */
function teamTools(flags: Flags): NavItem[] {
  const items: NavItem[] = [
    { href: "/", label: "Plan", icon: ListChecks },
    { href: "/cimientos", label: "Cimientos", icon: Layers },
    { href: "/reglas", label: "Reglas", icon: BookOpen },
  ];
  const kit = moduleBySlug("kit");
  if (kit && isEnabled(kit, flags)) items.push({ href: "/kit", label: kit.name, icon: Palette });
  return items;
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

const linkBase = "flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm transition-colors";
const linkIdle = "text-fg-2 hover:bg-bg-3 hover:text-fg";
const linkOn = "bg-bg-3 font-medium text-fg";

/** `flags` se inyecta en pruebas; en la app se usan las reales. */
export function SideNav({ flags = defaultFlags }: { flags?: Flags }) {
  const pathname = usePathname();
  const modules = productModules(flags);
  const tools = teamTools(flags);
  return (
    <nav className="flex flex-col gap-6" aria-label="Principal">
      <div>
        <p className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">Producto</p>
        <ul className="space-y-0.5">
          {modules.map((m) => {
            const Icon = ICONS[m.slug] ?? LayoutDashboard;
            const href = `/${m.slug}`;
            const on = isActive(pathname, href);
            return (
              <li key={m.slug}>
                <Link href={href} aria-current={on ? "page" : undefined} className={`${linkBase} ${on ? linkOn : linkIdle}`}>
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{m.name}</span>
                  {m.owner && <OwnerAvatar owner={m.owner} />}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <p className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">Construcción</p>
        <ul className="space-y-0.5">
          {tools.map((item) => {
            const on = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={on ? "page" : undefined} className={`${linkBase} ${on ? linkOn : linkIdle}`}>
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/** En pantallas pequeñas la navegación es una fila que se desplaza. */
export function MobileNav({ flags = defaultFlags }: { flags?: Flags }) {
  const pathname = usePathname();
  const tools = teamTools(flags);
  const items = [
    ...tools.slice(0, 1),
    ...productModules(flags).map((m) => ({ href: `/${m.slug}`, label: m.name })),
    ...tools.slice(1),
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none]" aria-label="Principal">
      {items.map((item) => {
        const on = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={`shrink-0 rounded-full border px-3 py-1 text-sm ${on ? "border-fg bg-fg text-bg" : "border-line text-fg-2"}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
