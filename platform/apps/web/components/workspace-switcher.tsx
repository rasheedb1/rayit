import "server-only";
import { cache } from "react";
import Link from "next/link";
import { listMyWorkspaces } from "@mc/db/queries/identidad";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { MESSAGES } from "@/lib/auth/messages";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { WorkspaceMenu, type EspacioVisible } from "./workspace-menu";

/**
 * En qué espacio estoy y cómo cambio de espacio. Va en el marco (CIM-4)
 * y es lo primero que se lee de la aplicación, así que tiene que
 * aguantar los tres casos sin romper la pantalla entera:
 *
 *   con sesión      el espacio actual y la lista de los míos;
 *   sin sesión      (modo demo, o una ruta pública como /kit) el nombre
 *                   del espacio que se está sirviendo y un enlace para
 *                   entrar de verdad;
 *   con la base caída  nada. Un marco no puede tumbar todas las rutas
 *                   por una consulta: el error de la pantalla ya lo
 *                   cuenta su propio error.tsx.
 */
const datos = cache(async (): Promise<{ actual: EspacioVisible; espacios: EspacioVisible[]; sesion: boolean } | null> => {
  try {
    const { workspaceId, identity, sesion } = await getCurrentContext();
    if (!sesion || !identity?.userId) {
      const ws = await withWorkspaceId(workspaceId, (tx) => getWorkspaceSettings(tx));
      return { actual: { id: ws.id, name: ws.name }, espacios: [], sesion: false };
    }
    const espacios = await withIdentity(identity, (tx) => listMyWorkspaces(tx));
    const actual = espacios.find((e) => e.id === workspaceId) ?? espacios[0];
    if (!actual) return null;
    return { actual: { id: actual.id, name: actual.name }, espacios: espacios.map((e) => ({ id: e.id, name: e.name })), sesion: true };
  } catch (err) {
    console.error("[workspace] no se pudo leer el espacio actual para el marco", err);
    return null;
  }
});

export async function WorkspaceSwitcher() {
  const d = await datos();
  if (!d) return null;

  if (!d.sesion) {
    return (
      <div className="border-b border-line px-2 py-2">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-2 text-[11px] font-bold text-ink-2"
            aria-hidden="true"
          >
            {[...d.actual.name.trim()][0]?.toLocaleUpperCase("es") ?? "·"}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{d.actual.name}</span>
        </div>
        <Link
          href="/login"
          className="mt-0.5 block rounded-sm px-2 py-1 text-xs text-muted underline underline-offset-4 transition-colors hover:text-ink"
        >
          {MESSAGES.cuenta.demo.entrar}
        </Link>
      </div>
    );
  }

  return (
    <div className="border-b border-line px-2 py-2">
      <WorkspaceMenu actual={d.actual} espacios={d.espacios} />
    </div>
  );
}
