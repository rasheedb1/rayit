/**
 * Identidad y pertenencia: quién entra, a qué espacios pertenece y qué
 * pasa la primera vez. Dueño: Rasheed (CIM-3).
 *
 * Es el único módulo de consultas que trabaja FUERA de un workspace,
 * porque responde justo lo que hay antes de tener uno. Por eso sus
 * lecturas reciben una IdentityTx (`db.withIdentity`, que fija
 * app.user_id y app.user_email) y no una WorkspaceTx: lo que puede ver
 * lo decide la RLS de app_user (0020, 0021, 0022) y la de membership
 * (0019), no un filtro escrito aquí.
 *
 * El orden del primer inicio de sesión, y por qué es ese:
 *
 *   1. upsertAppUserPorCorreo   con el correo que Supabase verificó.
 *      Una sola sentencia con ON CONFLICT (email): dos pestañas
 *      abriendo sesión a la vez no crean dos filas ni fallan.
 *   2. listMyWorkspaces          ya con el id, por la rama
 *      «user_id = current_user_id()» de membership.
 *   3. si no hay ninguno, createCreatorWorkspace dentro de
 *      withWorkspace(idNuevo, …, {userId}): la fila de workspace, la
 *      membresía de dueña y el creator_profile en UNA transacción, con
 *      current_workspace_id() ya valiendo el espacio nuevo, que es lo
 *      que las políticas de membership y creator_profile exigen.
 *
 * Nada de esto usa asWorker ni una función SECURITY DEFINER: la sesión
 * solo puede fijar el correo que verificó y el id que le corresponde.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { IdentityTx, WorkspaceTx } from '../client.ts';
import { appUser, creatorProfile, membership, workspace } from '../schema/index.ts';

export type AppUser = typeof appUser.$inferSelect;
export type MembershipRole = (typeof membership.$inferSelect)['role'];

/** Un espacio al que pertenece quien abrió la transacción. */
export interface MyWorkspace {
  id: string;
  name: string;
  slug: string;
  kind: 'creator' | 'agency';
  role: MembershipRole;
}

// ---------------------------------------------------------------------
// Nombres a partir del correo
// ---------------------------------------------------------------------

/**
 * Un nombre presentable desde el correo: «laura.mendez@x.com» →
 * «Laura Mendez». No adivina tildes ni apellidos; es el valor inicial
 * que la persona edita en /cuenta, igual que el nombre del espacio.
 *
 * Si el correo no da nada legible (cifras, una sola letra) devuelve
 * null y quien llama decide el texto por defecto: aquí no se inventan
 * cadenas de interfaz, que además irían en un solo idioma.
 */
export function nameFromEmail(email: string): string | null {
  const local = email.split('@')[0] ?? '';
  const words = local
    .split(/[._\-+]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0 && /\p{L}/u.test(w));
  if (words.length === 0) return null;
  const name = words.map((w) => w[0]!.toLocaleUpperCase('es') + w.slice(1)).join(' ');
  return name.length > 80 ? name.slice(0, 80).trimEnd() : name;
}

/** Slug base de un nombre: minúsculas, sin tildes, separado por guiones. */
export function slugify(text: string): string {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'espacio';
}

/**
 * El primer slug libre a partir de un nombre. `workspace` no lleva RLS
 * —es la tabla de tenencia, no una tabla de tenant— así que la
 * comprobación ve todos los slugs, que es justo lo que hace falta para
 * no chocar contra su índice único dentro de la transacción.
 */
export async function freeSlug(tx: IdentityTx | WorkspaceTx, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM workspace WHERE slug = $1', [candidate]);
    if ((rows[0]?.n ?? 0) === 0) return candidate;
  }
  // 50 espacios con el mismo nombre: se desempata con el reloj en vez
  // de seguir preguntando.
  return `${base}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------
// app_user
// ---------------------------------------------------------------------

/**
 * La fila de app_user del correo de la sesión; la crea si no existía.
 *
 * Una sola sentencia: el SELECT-y-si-no-INSERT tenía una carrera real
 * (dos pestañas terminando el enlace mágico a la vez) que terminaba en
 * un 23505 contra app_user_email_key. `DO UPDATE` en vez de
 * `DO NOTHING` porque solo así la sentencia DEVUELVE la fila que ya
 * existía, y de paso deja la última visita al día, que es para lo que
 * está esa columna.
 *
 * El nombre solo se rellena si la fila no tenía: el que la persona
 * escribió en /cuenta manda sobre el que se deduce del correo.
 */
export async function upsertAppUserPorCorreo(
  tx: IdentityTx,
  { email, name, locale }: { email: string; name?: string | null; locale?: string },
): Promise<AppUser> {
  const limpio = email.trim();
  const [row] = await tx.db
    .insert(appUser)
    .values({
      email: limpio,
      name: name ?? nameFromEmail(limpio),
      ...(locale ? { locale } : {}),
      lastSeenAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: appUser.email,
      set: {
        lastSeenAt: sql`now()`,
        name: sql`coalesce(${appUser.name}, excluded.name)`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error(`No se pudo registrar la sesión de ${limpio}: la base no devolvió la fila de app_user.`);
  return row;
}

/** Mi propia fila, por id (RLS: `id = current_user_id()`). */
export async function getAppUser(tx: IdentityTx | WorkspaceTx, id: string): Promise<AppUser | null> {
  const [row] = await tx.db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  return row ?? null;
}

/**
 * Cambia MI nombre. La política de UPDATE de app_user (0021, 0022) es
 * la que comprueba que la fila sea mía; aquí no se filtra por sesión a
 * mano, y por eso no hay forma de editar la de otra persona.
 */
export async function updateMyName(tx: IdentityTx, id: string, name: string): Promise<AppUser | null> {
  const limpio = name.trim();
  const [row] = await tx.db
    .update(appUser)
    .set({ name: limpio || null, updatedAt: sql`now()` })
    .where(eq(appUser.id, id))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------
// membership y workspace
// ---------------------------------------------------------------------

/**
 * A qué espacios pertenezco, en el orden en que entré. Sale de
 * membership por la rama «user_id = current_user_id()» de su política
 * (0019): si la transacción no fijó el id, esto son cero filas, no
 * todos los espacios.
 */
export async function listMyWorkspaces(tx: IdentityTx): Promise<MyWorkspace[]> {
  const rows = await tx.db
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      kind: workspace.kind,
      role: membership.role,
      createdAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .orderBy(asc(membership.createdAt), asc(workspace.name));
  return rows.map(({ createdAt: _createdAt, ...ws }) => ws);
}

/** ¿Tengo membresía en este espacio? Es la pregunta que valida la cookie mc.workspace. */
export async function isMemberOf(tx: IdentityTx, workspaceId: string, userId: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.workspaceId, workspaceId), eq(membership.userId, userId)))
    .limit(1);
  return Boolean(row);
}

export interface NuevoEspacio {
  /** Id que la transacción ya fijó como workspace actual. */
  workspaceId: string;
  userId: string;
  name: string;
  slug: string;
  /** Lo que la persona ve como nombre de creadora; por defecto, el del espacio. */
  displayName?: string;
  locale?: string;
  currency?: string;
  timezone?: string;
  country?: string | null;
}

/**
 * El espacio nuevo, su dueña y su ficha de creadora, en una
 * transacción.
 *
 * Se llama DENTRO de `withWorkspace(idNuevo, …, { userId })`: la fila
 * de workspace se inserta con ese mismo id, así que cuando llegan
 * membership y creator_profile —las dos con RLS— current_workspace_id()
 * ya vale lo que sus políticas exigen. Al revés no funciona: crear el
 * espacio en una transacción y sus filas hijas en otra deja un espacio
 * sin dueña si la segunda falla.
 *
 * El tipo es `creator`: el espacio de una agencia se crea desde otra
 * pantalla (AGE-1), con más datos que un correo.
 */
export async function createCreatorWorkspace(tx: WorkspaceTx, e: NuevoEspacio): Promise<MyWorkspace> {
  if (e.workspaceId !== tx.workspaceId) {
    throw new Error(
      `createCreatorWorkspace tiene que correr dentro de withWorkspace(${e.workspaceId}): la transacción fijó ${tx.workspaceId}.`,
    );
  }
  const [ws] = await tx.db
    .insert(workspace)
    .values({
      id: e.workspaceId,
      slug: e.slug,
      name: e.name,
      kind: 'creator',
      ...(e.locale ? { locale: e.locale } : {}),
      ...(e.currency ? { currency: e.currency } : {}),
      ...(e.timezone ? { timezone: e.timezone } : {}),
      ...(e.country ? { country: e.country } : {}),
    })
    .returning();
  if (!ws) throw new Error('No se pudo crear el espacio: la base no devolvió la fila de workspace.');

  await tx.db.insert(membership).values({ workspaceId: ws.id, userId: e.userId, role: 'owner' });
  await tx.db.insert(creatorProfile).values({
    workspaceId: ws.id,
    userId: e.userId,
    displayName: e.displayName?.trim() || e.name,
  });

  return { id: ws.id, name: ws.name, slug: ws.slug, kind: ws.kind, role: 'owner' };
}
