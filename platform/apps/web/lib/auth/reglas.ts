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
 * Los roles que operan Ventas en nombre de la creadora (VEN-14): aprobar,
 * editar, regenerar o saltar un mensaje retenido, responder a una marca
 * desde la bandeja, cancelar esa respuesta, corregir la intención de una
 * respuesta (una baja no se deshace), crear un contacto referido y marcar
 * un hilo como hecho o leído. Cada una escribe a una marca, gasta contra
 * el tope diario de IA o cambia lo que ve el resto del equipo. Un
 * 'viewer' o un 'client' (en una agencia, la marca misma, que no debe
 * leer ni contestar los hilos con otras marcas como si fuera la creadora)
 * ven las bandejas, no las tocan. Mismo grupo que PUEDEN_EDITAR_PERFIL.
 */
export const PUEDEN_OPERAR_VENTAS: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin", "member"]);

/**
 * Cuántos espacios puede tener una persona como propietaria. Sin tope,
 * un script con sesión crea miles de workspaces con su creator_profile.
 * Veinte cubre de sobra a una creadora que separa marcas; una agencia
 * con más clientes no crea espacios de creadora, crea el suyo (AGE-1).
 */
export const MAX_ESPACIOS_PROPIOS = 20;
