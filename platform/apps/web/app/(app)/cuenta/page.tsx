import type { Metadata } from "next";
import Link from "next/link";
import { getAppUser, listMyWorkspaces } from "@mc/db/queries/identidad";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { cerrarSesion } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { withIdentity } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { FormularioCuenta } from "./formulario";

export const metadata: Metadata = { title: "Tu cuenta" };
// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Lo mínimo de una cuenta: cómo te llamas, con qué correo entras, en
 * qué espacios estás y el botón de salir. Todo lo demás (foto, idioma,
 * notificaciones) llega cuando haya algo que configurar de verdad.
 */
export default async function CuentaPage() {
  const t = MESSAGES.cuenta;
  const { identity, sesion, workspaceId } = await getCurrentContext();

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

  const persona = await withIdentity(identity, (tx) => getAppUser(tx, identity.userId!));
  const espacios = await withIdentity(identity, (tx) => listMyWorkspaces(tx));

  return (
    <>
      <PageHeader eyebrow={MESSAGES.marca} title={t.titulo} description={t.descripcion} />

      <FormularioCuenta nombre={persona?.name ?? ""} correo={sesion.email} />

      <section className="mt-12">
        <SectionTitle>{t.espacios}</SectionTitle>
        <ul className="overflow-hidden rounded-md border border-border">
          {espacios.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
              <span className="min-w-0 truncate text-sm text-ink">{e.name}</span>
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
