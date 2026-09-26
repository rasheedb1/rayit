/**
 * Las reglas de la cuenta y de los espacios que comparten la interfaz y
 * el servidor. Van aquí, en un módulo sin "use server" y sin
 * dependencias, porque lib/auth/acciones.ts no puede exportar nada que
 * no sea una función async (Next lo exige en tiempo de ejecución) y la
 * página y el formulario las necesitan igual: antes el 80 estaba
 * escrito a mano en tres sitios y PUEDEN_RENOMBRAR dos veces.
 *
 * El servidor las vuelve a aplicar siempre; que la interfaz las conozca
 * es solo para no ofrecer lo que luego se va a rechazar.
 */
import type { MembershipRole } from "@mc/db/queries/identidad";

/** Tope de un nombre de persona o de espacio, en caracteres. */
export const MAX_NOMBRE = 80;

/** Los roles que pueden cambiarle el nombre a un espacio. */
export const PUEDEN_RENOMBRAR: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Los roles que pueden conectar, reconectar o desconectar un canal de
 * outreach y cambiar sus topes (VEN-9). Es lo más sensible de Ventas: el
 * buzón o el LinkedIn que se conecta escribe a las marcas en nombre de la
 * creadora. Un 'member', un 'viewer' o un 'client' ven la pantalla, no la
 * tocan.
 */
export const PUEDEN_GESTIONAR_CANALES: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Los roles que pueden recalcular el perfil comercial y editar su
 * narrativa (VEN-11). Recalcular gasta en el modelo contra el tope
 * diario del espacio y la narrativa es la voz de la creadora ante las
 * marcas: un 'viewer' o un 'client' (en una agencia, la marca misma) la
 * leen, no la reescriben.
 */
export const PUEDEN_EDITAR_PERFIL: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin", "member"]);

/**
 * Los roles que pueden cambiar el brief de outbound (VEN-7). El brief es
 * una regla del ESPACIO entero: lo que excluye desaparece del radar de
 * todo el equipo y ninguna cadencia le escribe (0064). Por eso lo
 * cambian los mismos que la política de envío y los canales; un
 * 'member' lo lee y lo aplica, no lo reescribe. La base dice lo mismo
 * con outreach_can_manage (0064 §5), así que esto solo evita ofrecer lo
 * que se va a rechazar.
 */
export const PUEDEN_EDITAR_BRIEF: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Cuántos espacios puede tener una persona como propietaria. Sin tope,
 * un script con sesión crea miles de workspaces con su creator_profile.
 * Veinte cubre de sobra a una creadora que separa marcas; una agencia
 * con más clientes no crea espacios de creadora, crea el suyo (AGE-1).
 */
export const MAX_ESPACIOS_PROPIOS = 20;
