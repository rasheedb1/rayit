import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { isAuthConfigured } from "@/lib/auth/config";
import { getIdentidadDeSesion } from "@/lib/workspace/current";
import { MESSAGES } from "../../(app)/accesos/_lib/messages";
import { crearMiEspacio } from "./actions";

const t = MESSAGES.aceptar.esperando;

export const metadata: Metadata = { title: t.meta };
export const dynamic = "force-dynamic";

/**
 * /invitacion, sin token: a donde manda getCurrentContext
 * (SIN_ESPACIO_POR_INVITACION) a quien tiene sesión pero ningún espacio
 * porque lo esperan en uno por invitación (ACC-4). Sin esta página, esa
 * persona no tendría ninguna pantalla que abrir hasta encontrar el
 * enlace.
 *
 * Dos salidas: abrir el enlace que le mandaron (no lo podemos repetir:
 * la base solo guarda su hash) o crear su propio espacio y aceptar
 * después. Quien ya tiene un espacio, o no tiene sesión, no tiene nada
 * que hacer aquí.
 */
export default async function EsperandoInvitacionPage() {
  if (!isAuthConfigured()) redirect("/");
  const yo = await getIdentidadDeSesion();
  if (!yo) redirect("/login");
  if (yo.workspaces.length > 0) redirect("/");

  return (
    <section className="grid gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
        <p className="mt-2 text-sm leading-5 text-ink-2">{t.texto}</p>
      </header>
      <form action={crearMiEspacio}>
        <Button type="submit" variant="secondary">
          {t.crearPropio}
        </Button>
      </form>
    </section>
  );
}
