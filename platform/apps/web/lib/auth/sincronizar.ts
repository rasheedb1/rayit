import "server-only";
import { randomUUID } from "node:crypto";
import {
  createCreatorWorkspace, freeSlug, listMyWorkspaces, nameFromEmail, upsertAppUserPorCorreo, type MyWorkspace,
} from "@mc/db/queries/identidad";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { MESSAGES } from "./messages";

/**
 * Lo que hace la aplicación la primera vez que alguien entra —y cada
 * vez que hace falta volver a averiguarlo—: encontrar (o crear) su fila
 * de app_user por el correo que Supabase verificó, ver a qué espacios
 * pertenece y, si no pertenece a ninguno, crearle el suyo.
 *
 * Es idempotente a propósito: se llama desde /auth/callback y también
 * desde lib/workspace/current.ts cuando la cookie no sirve. Dos
 * pestañas terminando el enlace mágico a la vez no crean dos personas
 * (ON CONFLICT sobre el único de email) ni dos espacios (la segunda ya
 * ve la membresía de la primera).
 *
 * Nada de esto corre en el navegador ni salta RLS: el correo y el id
 * viajan como identidad de la transacción (@mc/db, `withIdentity`) y
 * las políticas de 0019 a 0022 deciden qué se puede ver y escribir.
 */
export interface ContextoDeSesion {
  /** Fila de app_user. NO es el id de Supabase. */
  userId: string;
  email: string;
  nombre: string | null;
  /** Al menos uno: si no tenía, se acaba de crear. */
  workspaces: MyWorkspace[];
}

/** Lo mínimo que hace falta: el correo que Supabase verificó, y el nombre si vino. */
export interface QuienEntra {
  email: string;
  nombre?: string | null;
}

/** Drizzle envuelve el error de Postgres ("Failed query: …") y deja el original en cause. */
function mensajeCompleto(err: unknown): string {
  const partes: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return partes.join(" ← ");
}

export async function sincronizarSesion(quien: QuienEntra): Promise<ContextoDeSesion> {
  const email = quien.email.trim();
  const persona = await withIdentity({ email }, (tx) =>
    upsertAppUserPorCorreo(tx, { email, name: quien.nombre ?? null }),
  ).catch((err: unknown) => {
    // El fallo que va a pasar de verdad: la base todavía no tiene la
    // migración 0022, así que no existe la política «mi fila por el
    // correo verificado» y el alta choca contra el único de email. Sin
    // esta pista, el mensaje es un «row-level security» pelado en un
    // log de Vercel.
    if (/row-level security|duplicate key|current_user_email/.test(mensajeCompleto(err))) {
      throw new Error(
        "No se pudo registrar la sesión. Lo más probable: falta aplicar la migración 0022 " +
          "(db/migrations/0022_sesion_correo_verificado.sql) en esta base. `make db.migrate` desde platform/.",
        { cause: err },
      );
    }
    throw err;
  });

  const identity = { userId: persona.id, email };
  let workspaces = await withIdentity(identity, (tx) => listMyWorkspaces(tx));

  if (workspaces.length === 0) {
    const nombre = persona.name?.trim() || nameFromEmail(email) || MESSAGES.espacio.sinNombre;
    // El id se elige aquí porque la transacción tiene que fijarlo ANTES
    // de insertar: la membresía y el creator_profile llevan RLS y su
    // política compara contra current_workspace_id().
    const workspaceId = randomUUID();
    const creado = await withWorkspaceId(
      workspaceId,
      async (tx) => {
        const slug = await freeSlug(tx, nombre);
        return createCreatorWorkspace(tx, { workspaceId, userId: persona.id, name: nombre, slug });
      },
      identity,
    );
    workspaces = [creado];
  }

  return { userId: persona.id, email, nombre: persona.name, workspaces };
}
