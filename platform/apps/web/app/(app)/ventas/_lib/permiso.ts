import "server-only";
import { PUEDEN_OPERAR_VENTAS, PUEDEN_VER_BANDEJAS } from "@/lib/auth/reglas";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Si quien mira puede operar las bandejas de Ventas (VEN-14): 'owner',
 * 'admin' o 'member' del workspace actual (PUEDEN_OPERAR_VENTAS). Las
 * páginas lo usan para no ofrecer los botones ni los atajos, y cada
 * acción de /ventas/aprobaciones y /ventas/bandeja lo vuelve a mirar en
 * el servidor ANTES de tocar la base o de llamar al modelo. El modo sin
 * identidad lo decide tieneRol (lib/workspace/rol.ts).
 */
export const puedeOperarVentas = (): Promise<boolean> => tieneRol(PUEDEN_OPERAR_VENTAS);

/**
 * Si quien mira puede LEER las bandejas (PUEDEN_VER_BANDEJAS): las
 * conversaciones con las marcas y los mensajes retenidos. Un 'client' (en
 * una agencia, la marca misma) no: las páginas ni siquiera cargan los
 * hilos ni la cola.
 */
export const puedeVerBandejas = (): Promise<boolean> => tieneRol(PUEDEN_VER_BANDEJAS);
