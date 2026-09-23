import "server-only";
import type { MembershipRole } from "@mc/db/queries/identidad";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Quién puede tocar la configuración financiera del workspace.
 *
 * ESTO ES PROVISIONAL Y ESTÁ MARCADO. El destino es una línea:
 *
 *   // TODO(ACC-1): requirePermission('finanzas.ajustes.configurar')
 *
 * que es la llave con la que el catálogo de ACC-1 lo nombra
 * (packages/core/src/permisos.ts): el rol «Contador» la trae por
 * permisosDelModulo('finanzas') y el «Mánager» NO —solo lleva
 * finanzas.cobro.ver—, que es exactamente el criterio de terminado de
 * FIN-8. ACC-1 todavía no está en `main`, y «el Mánager no puede abrir
 * la pantalla» es un criterio que un comentario no puede probar: de ahí
 * este archivo, con el mismo patrón que lib/auth/reglas.ts ya usa para
 * PUEDEN_RENOMBRAR.
 *
 * Los roles de `membership` hoy (0001) son owner · admin · member ·
 * viewer · client; `finance` y `manager` llegan con ACC-3. El mapeo de
 * hoy, con el criterio de ACC-1: configurar el dinero es de quien manda
 * en el espacio. `member` —que es el Mánager de hoy—, `viewer` y
 * `client` no pueden.
 *
 * Ver docs/propuestas/FIN-8.md §0.3, decisión E.
 */
export const PUEDEN_CONFIGURAR_FINANZAS: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/** El permiso de ACC-1 que esto sustituye. Se nombra una vez, para que buscarlo lo encuentre. */
export const PERMISO_CONFIGURAR = "finanzas.ajustes.configurar";

/**
 * Mi rol en el espacio actual, o `null` si no hay sesión (una copia sin
 * llaves de Supabase Auth: el modo demo del README).
 *
 * Sale de la lista que la base ya devolvió para mi correo verificado
 * (lib/workspace/current.ts), no de la cookie: la cookie solo elige
 * entre mis espacios y no aporta rol ninguno.
 */
export async function miRolEnElEspacio(): Promise<MembershipRole | null> {
  const { workspaceId, workspaces, sesion } = await getCurrentContext();
  if (!sesion) return null;
  return workspaces.find((w) => w.id === workspaceId)?.role ?? null;
}

/**
 * Si puedo configurar Finanzas en el espacio actual.
 *
 * FALLA CERRADO, y la distinción importa: «no hay sesión» y «hay sesión
 * pero no encuentro mi rol en este espacio» son dos cosas distintas y
 * solo la primera sirve la pantalla.
 *
 *   sin sesión  → true. En una copia SIN llaves de Supabase Auth no hay
 *                 roles que consultar y la pantalla tiene que servir
 *                 igual: es el modo demo con el que corre `pnpm
 *                 verificar`. Con llaves y sin sesión no se llega aquí,
 *                 porque getCurrentContext ya redirigió a /login.
 *   con sesión y sin rol → false. No debería pasar (current.ts solo sirve
 *                 un espacio que la base devolvió como mío), pero si
 *                 pasara, «no sé cuál es tu rol» no puede responder «sí».
 *                 Escrito así porque la primera versión resolvía las dos
 *                 ramas con el mismo `rol === null` y abría la pantalla
 *                 en las dos.
 */
export async function puedeConfigurarFinanzas(): Promise<boolean> {
  const { workspaceId, workspaces, sesion } = await getCurrentContext();
  if (!sesion) return true;
  const rol = workspaces.find((w) => w.id === workspaceId)?.role;
  return rol !== undefined && PUEDEN_CONFIGURAR_FINANZAS.has(rol);
}

/** Se lanza cuando una Server Action de configuración la llama alguien sin el permiso. */
export class SinPermisoError extends Error {
  constructor() {
    super(`No tienes permiso para configurar Finanzas en este espacio (${PERMISO_CONFIGURAR}).`);
    this.name = "SinPermisoError";
  }
}

/**
 * La compuerta del servidor. La pantalla ya no ofrece el formulario a
 * quien no puede, pero eso es cortesía: la que decide es esta, y la
 * Server Action la vuelve a llamar. Una comprobación que solo está en
 * el render es una comprobación que no existe.
 */
export async function exigirConfigurarFinanzas(): Promise<void> {
  if (!(await puedeConfigurarFinanzas())) throw new SinPermisoError();
}
