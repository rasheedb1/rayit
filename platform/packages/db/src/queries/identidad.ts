/**
 * Identidad y pertenencia: quién entra, a qué espacios pertenece y qué
 * pasa la primera vez. Dueño: Rasheed (CIM-3).
 *
 * Es el único módulo de consultas que trabaja FUERA de un workspace,
 * porque responde justo lo que hay antes de tener uno. Por eso sus
 * lecturas reciben una IdentityTx (`db.withIdentity`, que fija
 * app.user_id y app.user_email) y no una WorkspaceTx: lo que puede ver
 * lo decide la RLS de app_user (0020, 0021 y sesion_correo_verificado) y la de membership
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
import { appUser, creatorProfile, membership, role, workspace, type RoleKey } from '../schema/index.ts';

export type AppUser = typeof appUser.$inferSelect;
/** La clave del rol de sistema de una membresía (0034: membership.role_id → role.key). */
export type MembershipRole = RoleKey;

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
 * La subdirección se descarta: «laura+marcas@x.com» es Laura, no
 * «Laura Marcas». Muchas creadoras separan con un alias el correo de
 * cada marca, y el sufijo terminaba siendo el nombre del espacio.
 *
 * Si el correo no da nada legible (cifras, una sola letra) devuelve
 * null y quien llama decide el texto por defecto: aquí no se inventan
 * cadenas de interfaz, que además irían en un solo idioma.
 */
export function nameFromEmail(email: string): string | null {
  const local = (email.split('@')[0] ?? '').split('+')[0] ?? '';
  const words = local
    .split(/[._\-]+/)
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
 * El primer slug libre a partir de un nombre. Hoy `workspace` no lleva
 * RLS, así que la comprobación ve todos los slugs. Es una SUGERENCIA,
 * no una garantía: dos altas a la vez pueden elegir el mismo, y el
 * pase de endurecimiento pone RLS en `workspace` (entonces solo se ve
 * el propio). Quien garantiza que no choque es createCreatorWorkspace,
 * que reintenta contra el índice único.
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
 * Una cuenta de Supabase Auth distinta de la que es dueña de la fila de
 * app_user de ese correo (migración sesion_correo_verificado,
 * `auth_user_id`). Pasa cuando un buzón se reasigna: la cuenta anterior
 * se borró en Auth y otra persona se registró con el mismo correo. La
 * cuenta nueva NO hereda la fila ni sus membresías; quien llama lo deja
 * en el log y cierra la sesión.
 *
 * No lleva el correo en el mensaje: va a los logs, y el id de app_user
 * basta para encontrar la fila.
 */
export class AuthIdentityMismatchError extends Error {
  readonly appUserId: string | null;
  /**
   * `correo_ajeno`: la fila de ese correo es de otra cuenta de Auth.
   * `otro_correo`: esta cuenta de Auth ya tiene fila con OTRO correo (lo
   * cambió en Supabase); el índice único de auth_user_id lo impide.
   */
  readonly motivo: 'correo_ajeno' | 'otro_correo';
  constructor(appUserId: string | null, motivo: 'correo_ajeno' | 'otro_correo' = 'correo_ajeno', options?: { cause?: unknown }) {
    super(
      motivo === 'otro_correo'
        ? 'Esta cuenta de Supabase Auth ya está ligada a otra fila de app_user con otro correo: cambiar de correo todavía no se admite.'
        : appUserId
          ? `La fila de app_user ${appUserId} pertenece a otra cuenta de Supabase Auth: no se entrega a esta sesión.`
          : 'La fila de app_user de este correo pertenece a otra cuenta de Supabase Auth: no se entrega a esta sesión.',
      options,
    );
    this.name = 'AuthIdentityMismatchError';
    this.appUserId = appUserId;
    this.motivo = motivo;
  }
}

/** ¿Es el choque contra el índice único de app_user.auth_user_id? */
function esOtroCorreo(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/app_user_auth_user_id_key/.test(e.message)) return true;
    const c = (e as { constraint?: unknown }).constraint;
    if (c === 'app_user_auth_user_id_key') return true;
  }
  return false;
}

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
 *
 * `authUserId` es el id de auth.users de la sesión. Se guarda la
 * primera vez (la fila del seed o de una invitación llega vacía) y, a
 * partir de ahí, el `setWhere` hace que el UPDATE solo ocurra si la
 * fila es de ESA cuenta: con otra, Postgres no toca nada, RETURNING no
 * devuelve fila y esto lanza AuthIdentityMismatchError. La comprobación
 * vive en la sentencia y no en un SELECT previo para que dos callbacks
 * a la vez no puedan colarse entre la lectura y la escritura.
 *
 * El id de la fila NUEVA lo pone quien llama, en la identidad de la
 * transacción: `withIdentity({ email, userId: randomUUID() }, …)`. Es lo
 * que pide la política de alta de app_user del pase de endurecimiento
 * (rasheed/endurecer-db, 0025 §4: `WITH CHECK (id = current_user_id())`,
 * «registrarse es crear TU fila»), y con la de hoy (WITH CHECK (true))
 * da igual. Si el correo ya tenía fila, ese id se descarta y se devuelve
 * el de la fila que ya existía: quien llama usa SIEMPRE el id devuelto.
 */
export async function upsertAppUserPorCorreo(
  tx: IdentityTx,
  { email, name, locale, authUserId }: { email: string; name?: string | null; locale?: string; authUserId: string },
): Promise<AppUser> {
  const limpio = email.trim();
  const idNuevo = tx.identity.userId;
  if (!idNuevo) {
    throw new Error(
      'upsertAppUserPorCorreo necesita withIdentity({ email, userId: <id nuevo> }): la fila se crea con el id de la transacción.',
    );
  }
  const [row] = await tx.db
    .insert(appUser)
    .values({
      id: idNuevo,
      email: limpio,
      name: name ?? nameFromEmail(limpio),
      authUserId,
      ...(locale ? { locale } : {}),
      lastSeenAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: appUser.email,
      set: {
        lastSeenAt: sql`now()`,
        name: sql`coalesce(${appUser.name}, excluded.name)`,
        authUserId: sql`coalesce(${appUser.authUserId}, excluded.auth_user_id)`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${appUser.authUserId} IS NULL OR ${appUser.authUserId} = excluded.auth_user_id`,
    })
    .returning()
    .catch((err: unknown) => {
      if (esOtroCorreo(err)) throw new AuthIdentityMismatchError(null, 'otro_correo', { cause: err });
      throw err;
    });
  if (!row) throw new AuthIdentityMismatchError(null);
  return row;
}

/** Mi propia fila, por id (RLS: `id = current_user_id()`). */
export async function getAppUser(tx: IdentityTx | WorkspaceTx, id: string): Promise<AppUser | null> {
  const [row] = await tx.db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  return row ?? null;
}

/**
 * Mi fila por el correo que la SESIÓN verificó, sin escribir nada.
 *
 * El correo no se pasa por parámetro a propósito: se compara contra
 * `current_user_email()`, que es lo que `withIdentity` fijó en la
 * transacción a partir de la sesión de Supabase (política
 * app_user_read_self_email, migración sesion_correo_verificado). Así el
 * id de app_user que la web usa como identidad no puede venir de nada
 * que mande el navegador —ni de una cookie firmada—, sino solo del
 * correo que el proveedor verificó.
 *
 * Y el correo no basta: si la fila ya está ligada a una cuenta de
 * Supabase Auth (`auth_user_id`) y no es la de esta sesión, lanza
 * AuthIdentityMismatchError en vez de devolverla. Una fila todavía sin
 * cuenta (la del seed, la de una invitación) se devuelve: la enlaza
 * /auth/callback la primera vez, y leer no escribe.
 *
 * Es el camino de LECTURA del inicio de sesión: un SELECT por un índice
 * único, sin UPDATE, para que pintar una pantalla no escriba en la base.
 */
export async function getMyAppUserByVerifiedEmail(tx: IdentityTx, authUserId: string): Promise<AppUser | null> {
  const [row] = await tx.db
    .select()
    .from(appUser)
    .where(sql`${appUser.email} = current_user_email()`)
    .limit(1);
  if (!row) return null;
  if (row.authUserId && row.authUserId !== authUserId) throw new AuthIdentityMismatchError(row.id);
  return row;
}

/** Quién soy y a qué espacios pertenezco. */
export interface MiSesion {
  user: AppUser;
  workspaces: MyWorkspace[];
}

/**
 * Las dos preguntas de cada petición con sesión, en UNA transacción y
 * sin escribir: quién soy (por el correo verificado, y solo si la fila
 * es de esta cuenta de Auth) y a qué espacios pertenezco.
 *
 * El `set_config` de en medio es necesario: la transacción se abre
 * sabiendo solo el correo, y la política de membership filtra por
 * `user_id = current_user_id()` (0019). Se fija con el id que acaba de
 * devolver app_user, no con uno que venga de fuera.
 *
 * Devuelve null si ese correo todavía no tiene fila: es el primer
 * inicio de sesión, y de darlo de alta se encarga quien llama.
 */
export async function getMyIdentityAndWorkspaces(tx: IdentityTx, authUserId: string): Promise<MiSesion | null> {
  const user = await getMyAppUserByVerifiedEmail(tx, authUserId);
  if (!user) return null;
  await tx.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
  const workspaces = await listMyWorkspaces(tx);
  return { user, workspaces };
}

/**
 * Un cerrojo por correo, para lo que solo puede pasar una vez: crear el
 * primer espacio de alguien.
 *
 * Se toma DENTRO de la transacción (`pg_advisory_xact_lock`) y se
 * suelta con ella, pase lo que pase. Sin él, dos peticiones a la vez de
 * quien todavía no tiene espacios —el callback del enlace mágico más el
 * prefetch de /resumen, o dos pestañas— leen las dos «no tengo
 * ninguno», y la persona termina con DOS espacios vacíos y dos
 * creator_profile. `ON CONFLICT` no lo evita: no hay ninguna
 * restricción única que se lo impida.
 *
 * hashtext() es estable dentro de una versión de Postgres y puede
 * colisionar; una colisión solo significa que dos correos distintos se
 * turnan un instante, no un dato malo.
 */
export async function lockByEmail(tx: IdentityTx | WorkspaceTx, email: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`on-cue/alta/${email.trim().toLowerCase()}`]);
}

/**
 * Cambia MI nombre. La política de UPDATE de app_user (0021 y sesion_correo_verificado) es
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
 *
 * Vale también dentro de un withWorkspace (misma rama de la política),
 * que es como el alta del primer espacio comprueba, ya con el cerrojo
 * tomado, si alguien se le adelantó.
 */
export async function listMyWorkspaces(tx: IdentityTx | WorkspaceTx): Promise<MyWorkspace[]> {
  const rows = await tx.db
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      kind: workspace.kind,
      // 0034: el rol es una fila de role; su clave es lo que la web
      // conoce ('owner', 'manager', …). role_read deja ver los de sistema
      // y los a medida del workspace fijado.
      role: role.key,
      createdAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .innerJoin(role, eq(role.id, membership.roleId))
    .orderBy(asc(membership.createdAt), asc(workspace.name));
  return rows.map(({ createdAt: _createdAt, role: rol, ...ws }) => ({ ...ws, role: rol as RoleKey }));
}

/** ¿Tengo membresía en este espacio? Es la pregunta que valida la cookie mc.workspace. */
export async function isMemberOf(tx: IdentityTx, workspaceId: string, userId: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ roleId: membership.roleId })
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
  // El slug que llega es una sugerencia (freeSlug). El único que decide
  // es el índice: ON CONFLICT (slug) DO NOTHING no necesita VER la fila
  // que choca —vale igual con RLS en workspace— y si no inserta nada se
  // prueba el siguiente sufijo.
  let ws: typeof workspace.$inferSelect | undefined;
  for (let i = 0; i < 50 && !ws; i++) {
    const slug = i === 0 ? e.slug : `${e.slug}-${i + 1}`;
    [ws] = await tx.db
      .insert(workspace)
      .values({
        id: e.workspaceId,
        slug: i < 49 ? slug : `${e.slug}-${Date.now().toString(36)}`,
        name: e.name,
        kind: 'creator',
        ...(e.locale ? { locale: e.locale } : {}),
        ...(e.currency ? { currency: e.currency } : {}),
        ...(e.timezone ? { timezone: e.timezone } : {}),
        ...(e.country ? { country: e.country } : {}),
      })
      .onConflictDoNothing({ target: workspace.slug })
      .returning();
  }
  if (!ws) throw new Error('No se pudo crear el espacio: la base no devolvió la fila de workspace.');

  // Dueña del espacio nuevo: el rol de sistema 'owner' de creador (0034).
  await tx.db
    .insert(membership)
    .values({ workspaceId: ws.id, userId: e.userId, roleId: sql`system_role_id('creator', 'owner')` });
  await tx.db.insert(creatorProfile).values({
    workspaceId: ws.id,
    userId: e.userId,
    displayName: e.displayName?.trim() || e.name,
  });

  return { id: ws.id, name: ws.name, slug: ws.slug, kind: ws.kind, role: 'owner' };
}

/**
 * Renombra el espacio de la transacción y, si su ficha de creador
 * todavía lleva el nombre con el que nació, también la ficha.
 *
 * Se llama DENTRO de `withWorkspace(id, …)`: la fila que se toca es la
 * de `tx.workspaceId`, nunca un id que venga de fuera, y la RLS de
 * creator_profile acota la segunda escritura al mismo espacio. Quién
 * puede renombrar (owner o admin) lo comprueba quien llama, contra sus
 * membresías.
 *
 * La ficha solo se toca cuando su display_name es igual al nombre
 * VIEJO del espacio, que es como la deja createCreatorWorkspace. Si la
 * creadora ya le puso otro nombre a su ficha, renombrar el espacio no
 * se lo pisa.
 *
 * Devuelve false si el espacio no existe (o la transacción no lo ve).
 */
export async function renameWorkspace(tx: WorkspaceTx, name: string): Promise<boolean> {
  const limpio = name.trim();
  if (!limpio) throw new Error('renameWorkspace necesita un nombre.');
  const [antes] = await tx.db
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, tx.workspaceId))
    .limit(1);
  if (!antes) return false;

  await tx.db
    .update(workspace)
    .set({ name: limpio, updatedAt: sql`now()` })
    .where(eq(workspace.id, tx.workspaceId));
  await tx.db
    .update(creatorProfile)
    .set({ displayName: limpio, updatedAt: sql`now()` })
    .where(and(eq(creatorProfile.workspaceId, tx.workspaceId), eq(creatorProfile.displayName, antes.name)));
  return true;
}
