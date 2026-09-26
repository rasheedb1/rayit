import "server-only";
import { PUEDEN_EDITAR_BRIEF } from "@/lib/auth/reglas";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Si quien mira puede cambiar el brief de outbound: 'owner' o 'admin'
 * del workspace actual (PUEDEN_EDITAR_BRIEF). La página lo usa para
 * enseñar el brief sin ofrecer «Guardar», y la acción lo vuelve a mirar
 * antes de escribir; la última palabra es de la base (0070 §5, las
 * políticas RESTRICTIVE de outbound_brief). El modo sin identidad lo
 * decide tieneRol (lib/workspace/rol.ts).
 */
export const puedeEditarElBrief = (): Promise<boolean> => tieneRol(PUEDEN_EDITAR_BRIEF);
