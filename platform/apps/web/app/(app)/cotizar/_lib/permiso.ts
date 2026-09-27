import "server-only";
import { PUEDEN_OPERAR_COTIZAR } from "@/lib/auth/reglas";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Si quien mira puede operar Cotizar: 'owner', 'admin' o 'member' del
 * workspace actual (PUEDEN_OPERAR_COTIZAR). Cada acción de escritura de
 * cotizar/actions.ts lo mira en el servidor ANTES de tocar la base. El
 * modo sin identidad lo decide tieneRol (lib/workspace/rol.ts).
 */
export const puedeOperarCotizar = (): Promise<boolean> => tieneRol(PUEDEN_OPERAR_COTIZAR);
