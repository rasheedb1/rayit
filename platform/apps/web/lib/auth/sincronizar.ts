import "server-only";
import { randomUUID } from "node:crypto";
import {
  createCreatorWorkspace, freeSlug, getMyIdentityAndWorkspaces, listMyWorkspaces, lockByEmail, nameFromEmail,
  upsertAppUserPorCorreo, type MyWorkspace,
} from "@mc/db/queries/identidad";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { MESSAGES } from "./messages";

/**
 * Lo que la aplicación sabe de quien entró, y quién puede escribirlo.
 *
 * Hay DOS caminos a propósito, porque hacían falta por separado:
 *
 *   leerSesion()       SOLO LEE. Es el de cada petición que pinta una
 *                      pantalla: quién soy (por el correo que Supabase
 *                      verificó) y a qué espacios pertenezco, en una
 *                      transacción y sin un solo UPDATE. Antes este
 *                      camino llamaba al de abajo, así que CADA GET
 *                      escribía `last_seen_at`: una escritura por
 *                      render, en una petición que el navegador puede
 *                      repetir y que un CDN puede reintentar.
 *
 *   registrarEntrada() ESCRIBE, y por eso lo llama /auth/callback y
 *                      nadie más en el camino normal: da de alta la
 *                      fila de app_user si no existía, deja la última
 *                      visita al día y, si la persona no pertenece a
 *                      ningún espacio, le crea el suyo.
 *
 * El único caso en que una lectura cae al segundo es el que no tiene
 * otra salida: hay sesión de Supabase pero no hay fila de app_user (el
 * callback falló a medias) o no hay ningún espacio. Ahí no hay nada que
 * servir sin escribir.
 *
 * Nada de esto corre en el navegador ni salta RLS: el correo y el id
 * viajan como identidad de la transacción (@mc/db, `withIdentity`) y
 * las políticas de 0019 a 0021 y las de CIM-3 (sesion_correo_verificado, membership_alta_propia) deciden qué se puede ver y escribir.
 */
export interface ContextoDeSesion {
  /** Fila de app_user. NO es el id de Supabase. */
  userId: string;
  email: string;
  nombre: string | null;
  /** Al menos uno: si no tenía, se acaba de crear. */
  workspaces: MyWorkspace[];
}

/**
 * Lo mínimo que hace falta: el correo que Supabase verificó, el id de
 * su cuenta de Auth (auth.users) y el nombre si vino. El id de Auth es
 * el que ata la fila de app_user a UNA cuenta: otra cuenta con el mismo
 * correo no la hereda (AuthIdentityMismatchError, @mc/db).
 */
export interface QuienEntra {
  email: string;
  authUserId: string;
  nombre?: string | null;
}

/**
 * La migración que hace posible el inicio de sesión, nombrada por lo
 * que crea y por el final de su archivo, NO por su número: el número
 * lo decide el integrador al ordenar las ramas y cambió ya una vez
 * (0022 → 0027). Si se renombra el archivo, esto es lo único que hay
 * que tocar.
 */
export const MIGRACION_DE_SESION = "la que crea current_user_email() (db/migrations/*_sesion_correo_verificado.sql)";

/** Drizzle envuelve el error de Postgres ("Failed query: …") y deja el original en cause. */
function mensajeCompleto(err: unknown): string {
  const partes: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return partes.join(" ← ");
}

/**
 * El fallo que va a pasar de verdad: la base todavía no tiene la
 * migración de sesión, así que no existe la política «mi fila por el
 * correo verificado» (ni la columna auth_user_id) y el alta choca
 * contra el único de email. Sin esta pista, el mensaje es un
 * «row-level security» pelado en un log de Vercel.
 */
function conPista(err: unknown): never {
  if (/row-level security|duplicate key|current_user_email|auth_user_id/.test(mensajeCompleto(err))) {
    throw new Error(
      `No se pudo registrar la sesión. Lo más probable: falta aplicar en esta base la migración ${MIGRACION_DE_SESION}. ` +
        "`make db.migrate` desde platform/.",
      { cause: err },
    );
  }
  throw err;
}

/**
 * SOLO LECTURA: quién soy y a qué espacios pertenezco, según el correo
 * verificado de la sesión. null si ese correo todavía no tiene fila.
 */
export async function leerSesion({ email, authUserId }: QuienEntra): Promise<ContextoDeSesion | null> {
  const limpio = email.trim();
  const mio = await withIdentity({ email: limpio }, (tx) => getMyIdentityAndWorkspaces(tx, authUserId)).catch(conPista);
  if (!mio) return null;
  return { userId: mio.user.id, email: limpio, nombre: mio.user.name, workspaces: mio.workspaces };
}

/**
 * ESCRIBE: el alta de quien entra por /auth/callback. Idempotente —el
 * upsert va por el único de email y el espacio solo se crea si no hay
 * ninguno— y protegido contra dos peticiones a la vez.
 */
export async function registrarEntrada(quien: QuienEntra): Promise<ContextoDeSesion> {
  const email = quien.email.trim();
  // `userId` es el id que tendrá la fila SI es nueva: la política de alta
  // de app_user del pase de endurecimiento exige id = current_user_id().
  // Si el correo ya tenía fila, se devuelve la suya y este se descarta.
  const persona = await withIdentity({ email, userId: randomUUID() }, (tx) =>
    upsertAppUserPorCorreo(tx, { email, name: quien.nombre ?? null, authUserId: quien.authUserId }),
  ).catch(conPista);

  const identity = { userId: persona.id, email };
  let workspaces = await withIdentity(identity, (tx) => listMyWorkspaces(tx));
  if (workspaces.length === 0) {
    workspaces = await crearPrimerEspacio({ email, identity, nombrePersona: persona.name });
  }

  return { userId: persona.id, email, nombre: persona.name, workspaces };
}

/**
 * El primer espacio de alguien, una sola vez aunque lleguen dos
 * peticiones a la vez.
 *
 * Todo pasa DENTRO de una transacción con el id del espacio nuevo ya
 * fijado, porque membership y creator_profile llevan RLS y sus
 * políticas comparan contra current_workspace_id(). Dentro, y en este
 * orden:
 *
 *   1. `pg_advisory_xact_lock` por correo. Quien llegue segundo espera
 *      aquí hasta que el primero confirme o deshaga.
 *   2. volver a preguntar «¿tengo espacios?» YA CON EL CERROJO. Si el
 *      primero terminó, esto devuelve el suyo y la segunda petición no
 *      crea nada: sin este paso, las dos leían «ninguno» antes de
 *      empezar y la persona terminaba con dos espacios vacíos y dos
 *      creator_profile.
 *   3. el alta, si sigue haciendo falta.
 */
async function crearPrimerEspacio({
  email,
  identity,
  nombrePersona,
}: {
  email: string;
  identity: { userId: string; email: string };
  nombrePersona: string | null;
}): Promise<MyWorkspace[]> {
  const nombre = nombrePersona?.trim() || nameFromEmail(email) || MESSAGES.espacio.sinNombre;
  const workspaceId = randomUUID();
  return withWorkspaceId(
    workspaceId,
    async (tx) => {
      await lockByEmail(tx, email);
      const yaTengo = await listMyWorkspaces(tx);
      if (yaTengo.length > 0) return yaTengo;
      const slug = await freeSlug(tx, nombre);
      return [await createCreatorWorkspace(tx, { workspaceId, userId: identity.userId, name: nombre, slug })];
    },
    identity,
  );
}

/**
 * El camino de lectura con su red de seguridad: lee, y solo si no hay
 * nada que leer (ni fila ni espacios) da de alta. Lo usa
 * lib/workspace/current.ts.
 */
export async function leerOCrearSesion(quien: QuienEntra): Promise<ContextoDeSesion> {
  const mio = await leerSesion(quien);
  if (mio && mio.workspaces.length > 0) return mio;
  return registrarEntrada(quien);
}
