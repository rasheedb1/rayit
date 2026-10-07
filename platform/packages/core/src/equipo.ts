/**
 * Equipo (ACC-4): las reglas de invitar, cambiar el rol y quitar que no
 * dependen de la base. Dueño: Rasheed. El catálogo, los roles de
 * fábrica y can() son de ACC-1 (permisos.ts, Nicolás); esto se apoya en
 * ellos y no los repite.
 *
 * Las mismas reglas las hace cumplir la base (0078_equipo.sql): la
 * pantalla las usa para no OFRECER lo que se va a rechazar, y la Server
 * Action para responder con un mensaje claro antes de ir a la base. Si
 * una de las dos capas se equivoca, la otra sigue cerrando.
 */
import {
  rolSistema,
  type Permiso,
  type RoleKey,
  type WorkspaceKind,
} from './permisos.ts';

/**
 * Las dos casillas que se le pueden marcar a un Mánager de creador
 * (decisión E de ACC-accesos-y-roles.md): el dinero y las cuentas
 * conectadas no entran en el rol por defecto; se dan a propósito, al
 * invitar o después, y quedan en la bitácora.
 *
 *   finanzas    «también puede ver mis finanzas»: facturas, gastos y el
 *               flujo de caja. Ver, no operar (el cobro de sus campañas,
 *               finanzas.cobro.ver, ya lo trae el rol).
 *   conexiones  «también puede conectar mis cuentas»: conectar y quitar,
 *               exactamente lo que ACC-8 espera (docs/propuestas/ACC-8.md §1.3).
 *
 * La lista es CERRADA y la base la repite en un CHECK
 * (membership_extra_permissions_allowed e invitation_extra_permissions_allowed,
 * 0078 §1); packages/db/test/equipo.test.ts comprueba que coinciden.
 */
export const CASILLAS = {
  finanzas: ['finanzas.factura.ver', 'finanzas.gasto.ver', 'finanzas.flujo.ver'],
  conexiones: ['conexiones.cuenta.conectar', 'conexiones.cuenta.desconectar'],
} as const satisfies Record<string, readonly Permiso[]>;

export type Casilla = keyof typeof CASILLAS;
export const NOMBRES_DE_CASILLA = Object.keys(CASILLAS) as Casilla[];

/** Todos los permisos que puede llevar extra_permissions, en el orden de la base. */
export const EXTRA_PERMISOS: readonly Permiso[] = NOMBRES_DE_CASILLA.flatMap((c) => CASILLAS[c]);

/** ¿Es un permiso que cabe en extra_permissions? */
export function isExtraPermiso(value: string): value is Permiso {
  return (EXTRA_PERMISOS as readonly string[]).includes(value);
}

/**
 * Qué roles admiten las casillas: hoy solo el Mánager de creador, que es
 * para quien existen. A un Dueño no le añaden nada y a un Editor no se
 * le ofrecen: si alguien necesita más, es otro rol (o un rol a medida,
 * ACC-9).
 */
export function admiteCasillas(kind: WorkspaceKind, key: string): boolean {
  return kind === 'creator' && key === 'manager';
}

/** Los permisos extra de unas casillas marcadas, sin repetir y en el orden de EXTRA_PERMISOS. */
export function permisosDeCasillas(casillas: Iterable<Casilla>): Permiso[] {
  const marcadas = new Set(casillas);
  return NOMBRES_DE_CASILLA.filter((c) => marcadas.has(c)).flatMap((c) => CASILLAS[c]);
}

/**
 * Qué casillas están marcadas según los permisos extra guardados. Una
 * casilla cuenta si están TODOS sus permisos: medio conjunto (que solo
 * podría dejarlo alguien escribiendo a mano en la base) se pinta
 * desmarcado, que es lo conservador.
 */
export function casillasDe(extras: readonly string[]): Casilla[] {
  const tiene = new Set(extras);
  return NOMBRES_DE_CASILLA.filter((c) => CASILLAS[c].every((p) => tiene.has(p)));
}

/** Lo que tendrá una persona: su rol de sistema más sus casillas. Para pruebas y para pintar; la sesión lo lee de la base. */
export function permisosConCasillas(kind: WorkspaceKind, key: RoleKey, casillas: Iterable<Casilla> = []): ReadonlySet<Permiso> {
  const rol = rolSistema(kind, key);
  const out = new Set<Permiso>(rol?.permisos ?? []);
  for (const p of permisosDeCasillas(casillas)) out.add(p);
  return out;
}

/** Cuántos días vale el enlace de una invitación. Pasado ese plazo no sirve y hay que invitar de nuevo. */
export const INVITACION_VIGENCIA_DIAS = 7;

/**
 * Cuántas invitaciones puede crear un espacio en 24 horas. Cada una
 * puede ser un correo de la plataforma con el nombre del espacio, que
 * pone quien invita: sin techo, un espacio con un nombre engañoso
 * mandaría correos sin fin firmados por On Cue. El techo de verdad lo
 * pone la base (disparador invitation_daily_cap, 0079 §7); este número
 * es para la frase, y una prueba exige que sean el mismo.
 */
export const INVITACIONES_POR_DIA = 20;

/** Cuándo vence una invitación creada en `ahora`. */
export function venceInvitacion(ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() + INVITACION_VIGENCIA_DIAS * 24 * 60 * 60 * 1000);
}

/** Un correo con el criterio de un campo de invitación: hay un @ y algo a cada lado, sin espacios, y cabe. */
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CORREO_MAX = 254;

/** El correo como se guarda y se compara: recortado y en minúsculas (la base es citext, pero el enlace se arma con este). */
export function normalizarCorreo(correo: string): string | null {
  const c = correo.trim().toLowerCase();
  return c.length > 0 && c.length <= CORREO_MAX && CORREO_RE.test(c) ? c : null;
}
