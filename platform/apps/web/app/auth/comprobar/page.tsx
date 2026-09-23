import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Marca } from "@/components/marca";
import { Button } from "@/components/ui/button";
import { cerrarSesion } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { destinoSeguro } from "@/lib/auth/rutas";
import { getSesion } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: MESSAGES.comprobar.meta,
  robots: { index: false, follow: false },
};

/**
 * Siempre en la petición: enseña el correo de QUIEN mira. Sin esto, en
 * una compilación sin llaves `getSesion()` devuelve null sin tocar las
 * cabeceras y Next congelaba la página como una redirección estática a
 * /login (salía «○» en `next build`).
 */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ next?: string }> };

/**
 * «Entraste como x@y. ¿Eres tú?» — la parada contra el login CSRF.
 *
 * Llega aquí /auth/confirm cuando el enlace se canjeó en un navegador
 * que NO lo pidió (lib/auth/pedido.ts): otro dispositivo, el navegador
 * interno de la app de correo, o un enlace que alguien pidió para SU
 * correo y le mandó a otra persona. En los dos primeros casos es un clic
 * de más con el correo propio a la vista; en el tercero es lo que evita
 * trabajar sin saberlo dentro de la cuenta del atacante.
 *
 * Es pública (prefijo /auth en lib/auth/rutas.ts), pero sin sesión no
 * tiene nada que enseñar y manda a /login. No toca la base: el correo
 * sale de la sesión que el middleware ya verificó.
 */
export default async function ComprobarPage({ searchParams }: Props) {
  const sesion = await getSesion();
  if (!sesion) redirect("/login");
  const { next } = await searchParams;
  const t = MESSAGES.comprobar;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
      <Marca />

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
      <p className="mt-2 break-all font-mono text-sm text-ink">{sesion.email}</p>
      <p className="mt-4 mb-8 text-sm leading-5 text-ink-2">{t.descripcion}</p>

      <div className="flex flex-col gap-2">
        <Button href={destinoSeguro(next)} variant="primary" className="w-full">
          {t.seguir}
        </Button>
        <form action={cerrarSesion}>
          <Button type="submit" variant="ghost" className="w-full">
            {t.salir}
          </Button>
        </form>
      </div>
    </main>
  );
}
