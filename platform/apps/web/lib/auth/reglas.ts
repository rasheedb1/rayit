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
 * Cuántos espacios puede tener una persona como propietaria. Sin tope,
 * un script con sesión crea miles de workspaces con su creator_profile.
 * Veinte cubre de sobra a una creadora que separa marcas; una agencia
 * con más clientes no crea espacios de creadora, crea el suyo (AGE-1).
 */
export const MAX_ESPACIOS_PROPIOS = 20;
