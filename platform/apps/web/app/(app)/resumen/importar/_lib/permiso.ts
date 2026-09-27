import "server-only";
import { PUEDEN_IMPORTAR_METRICAS } from "@/lib/auth/reglas";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Si quien mira puede importar métricas desde un CSV: 'owner', 'admin' o
 * 'member' del workspace actual (PUEDEN_IMPORTAR_METRICAS). La escritura
 * (importarLote) lo mira en el servidor ANTES de leer el archivo o de
 * tocar la base. El modo sin identidad lo decide tieneRol.
 */
export const puedeImportar = (): Promise<boolean> => tieneRol(PUEDEN_IMPORTAR_METRICAS);
