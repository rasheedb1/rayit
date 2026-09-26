import "server-only";
import type { MembershipRole } from "@mc/db/queries/identidad";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Los roles que pueden operar la cola del outreach: reintentar lo
 * fallido y cancelar en masa (hasta BULK_MAX mensajes de una vez). Es la
 * acción más destructiva de Ventas: cancela mensajes a marcas o los
 * vuelve a mandar. Quien trabaja las cadencias ('owner', 'admin',
 * 'member') la opera; un 'viewer' o un 'client' (en una agencia, la
 * marca misma) ven la cola, no la tocan. La base dice lo mismo
 * (outbound_touch_guard_operator, 0067): esto solo evita ofrecer lo que
 * se va a rechazar.
 */
export const PUEDEN_OPERAR_LA_COLA: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin", "member"]);

/**
 * Si quien mira puede operar la cola (PUEDEN_OPERAR_LA_COLA) en el
 * workspace actual. La página lo usa para no ofrecer las casillas ni los
 * botones de reintentar, y las tres acciones lo vuelven a mirar antes de
 * abrir la transacción. El modo sin identidad lo decide tieneRol
 * (lib/workspace/rol.ts).
 */
export const puedeOperarLaCola = (): Promise<boolean> => tieneRol(PUEDEN_OPERAR_LA_COLA);
