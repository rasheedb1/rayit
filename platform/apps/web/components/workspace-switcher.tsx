import "server-only";
import { cache } from "react";
import Link from "next/link";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { isAuthConfigured } from "@/lib/auth/config";
import { MESSAGES } from "@/lib/auth/messages";
import { getSesion } from "@/lib/auth/session";
import { withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { inicial } from "@/lib/workspace/inicial";
import { WorkspaceMenu, type EspacioVisible } from "./workspace-menu";

/**
 * En qué espacio estoy y cómo cambio de espacio. Va en el marco (CIM-4)
 * y es lo primero que se lee de la aplicación, así que tiene que
 * aguantar cuatro casos sin romper la pantalla entera:
 *
 *   sesion    el espacio actual y la lista de los míos, que ya vienen
 *             resueltos en el contexto de la petición: este componente
 *             no consulta nada.
 *   entrar    sin sesión y con autenticación configurada: SOLO el
 *             enlace para entrar, sin ningún nombre. /kit es pública y
 *             vive dentro de (app), así que cualquiera que abriera esa
 *             URL en el sitio desplegado veía el nombre del espacio de
 *             DEMO_WORKSPACE_ID —o el del seed con
 *             ALLOW_SEED_WORKSPACE=1—. No son datos del negocio, pero
 *             es el nombre de un espacio real enseñado a quien pase.
 *   demo      sin llaves de Supabase: una copia local donde no hay
 *             sesión posible y el espacio del seed es justamente lo que
 *             se está enseñando. Ahí sí se pinta el nombre.
 *   nada      la base no respondió. Un marco no puede tumbar todas las
 *             rutas por una consulta: el error de la pantalla ya lo
 *             cuenta su propio error.tsx.
 */
type Vista =
  | { modo: "sesion"; actual: EspacioVisible; espacios: EspacioVisible[] }
  | { modo: "demo"; actual: EspacioVisible }
  | { modo: "entrar" };

const datos = cache(async (): Promise<Vista | null> => {
  try {
    // Primero la sesión, y solo después el contexto: con llaves y sin
    // sesión, getCurrentContext manda a /login (falla cerrado), y en una
    // ruta pública del grupo (app) como /kit el marco tiene que poder
    // pintarse igual, con el enlace para entrar.
    if (isAuthConfigured() && !(await getSesion())) return { modo: "entrar" };
    const { workspaceId, sesion, workspaces } = await getCurrentContext();
    if (!sesion) {
      const ws = await withWorkspaceId(workspaceId, (tx) => getWorkspaceSettings(tx));
      return { modo: "demo", actual: { id: ws.id, name: ws.name } };
    }
    const actual = workspaces.find((e) => e.id === workspaceId) ?? workspaces[0];
    if (!actual) return null;
    return {
      modo: "sesion",
      actual: { id: actual.id, name: actual.name },
      espacios: workspaces.map((e) => ({ id: e.id, name: e.name })),
    };
  } catch (err) {
    console.error("[workspace] no se pudo leer el espacio actual para el marco", err);
    return null;
  }
});

export async function WorkspaceSwitcher() {
  const d = await datos();
  if (!d) return null;

  if (d.modo === "entrar") {
    return (
      <div className="border-b border-line px-2 py-2">
        <EnlaceEntrar />
      </div>
    );
  }

  if (d.modo === "demo") {
    return (
      <div className="border-b border-line px-2 py-2">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-2 text-[11px] font-bold text-ink-2"
            aria-hidden="true"
          >
            {inicial(d.actual.name)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{d.actual.name}</span>
        </div>
        <EnlaceEntrar />
      </div>
    );
  }

  return (
    <div className="border-b border-line px-2 py-2">
      <WorkspaceMenu actual={d.actual} espacios={d.espacios} />
    </div>
  );
}

function EnlaceEntrar() {
  return (
    <Link
      href="/login"
      className="mt-0.5 block rounded-sm px-2 py-1 text-xs text-muted underline underline-offset-4 transition-colors hover:text-ink"
    >
      {MESSAGES.cuenta.demo.entrar}
    </Link>
  );
}
