import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Marca } from "@/components/marca";

/**
 * El marco del enlace de una invitación de Equipo (ACC-4): /invitacion
 * y /invitacion/<token>.
 *
 * Fuera del grupo (app) a propósito, como /login: sin barra lateral, sin
 * navegación de módulos y sin selector de espacio. Quien abre el enlace
 * puede no pertenecer todavía a NINGÚN espacio (lib/auth/sincronizar.ts
 * no le crea uno propio si lo esperan en otro), y el marco de la
 * aplicación necesita uno para pintarse. Y aunque lo tuviera, el primer
 * contacto de un mánager con On Cue tiene que parecer una invitación,
 * no el espacio de otra persona.
 *
 * Sí pide sesión: no está en RUTAS_PUBLICAS (lib/auth/rutas.ts), así que
 * el middleware manda a /login?next=… y vuelve aquí.
 */
export const metadata: Metadata = {
  // Un enlace privado no se indexa aunque alguien lo pegue en una web.
  robots: { index: false, follow: false },
};

// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

export default function InvitacionLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-12">
      <Marca />
      {children}
    </main>
  );
}
