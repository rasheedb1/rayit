import type { Metadata } from "next";
import Link from "next/link";
import { getAppUser } from "@mc/db/queries/identidad";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { cerrarSesion } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { PUEDEN_RENOMBRAR } from "@/lib/auth/reglas";
import { withIdentity } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { FormularioCuenta } from "./formulario";
import { RenombrarEspacio } from "./renombrar";

export const metadata: Metadata = { title: MESSAGES.cuenta.meta };
// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Lo mínimo de una cuenta: cómo te llamas, con qué correo entras, en
 * qué espacios estás y el botón de salir. Todo lo demás (foto, idioma,
 * notificaciones) llega cuando haya algo que configurar de verdad.
 */
export default async function CuentaPage() {
  const t = MESSAGES.cuenta;
  const { identity, sesion, workspaceId, workspaces } = await getCurrentContext();

  // Sin sesión solo se llega aquí en modo demo: con Supabase Auth
  // configurado, el middleware manda a /login antes de renderizar.
  if (!sesion || !identity?.userId) {
    return (
      <>
        <PageHeader eyebrow={t.titulo} title={t.demo.titulo} description={t.demo.descripcion} />
        <Button href="/login" variant="primary">
          {t.demo.entrar}
        </Button>
      </>
    );
  }

  // Los espacios ya vienen resueltos en el contexto de la petición: no
  // se vuelven a pedir.
  const espacios = workspaces;
  const persona = await withIdentity(identity, (tx) => getAppUser(tx, identity.userId!));

  return (
    <>
      <PageHeader eyebrow={MESSAGES.marca} title={t.titulo} description={t.descripcion} />

      <FormularioCuenta nombre={persona?.name ?? ""} correo={sesion.email} />

      <section className="mt-12">
        <SectionTitle>{t.espacios}</SectionTitle>
        <p className="mb-3 text-xs text-muted">{t.renombrar.ayuda}</p>
        <ul className="overflow-hidden rounded-md border border-border">
          {espacios.map((e) => (
            // A 400 px no caben en una línea el nombre, «Renombrar», el rol y
            // la pastilla: el nombre —lo que se viene a ver aquí— quedaba
            // cortado. En móvil va arriba y el resto debajo.
            <li
              key={e.id}
              className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              {PUEDEN_RENOMBRAR.has(e.role) ? (
                <RenombrarEspacio id={e.id} nombre={e.name} />
              ) : (
                <span className="min-w-0 truncate text-sm text-ink">{e.name}</span>
              )}
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted">{t.rol[e.role]}</span>
                {e.id === workspaceId && <Pill kind="good">{t.actual}</Pill>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <SectionTitle>{t.sesion}</SectionTitle>
        <form action={cerrarSesion}>
          <Button type="submit" variant="secondary">
            {t.cerrarSesion}
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted">
          <Link href="/resumen" className="underline underline-offset-4 hover:text-ink">
            {t.volver}
          </Link>
        </p>
      </section>
    </>
  );
}
