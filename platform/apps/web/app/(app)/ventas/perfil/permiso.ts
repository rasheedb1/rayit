import "server-only";
import { PUEDEN_EDITAR_PERFIL } from "@/lib/auth/reglas";
import { tieneRol } from "@/lib/workspace/rol";

/**
 * Si quien mira puede recalcular el perfil comercial y editar su
 * narrativa: 'owner', 'admin' o 'member' del workspace actual
 * (PUEDEN_EDITAR_PERFIL). La página lo usa para no ofrecer «Recalcular»
 * ni «Editar», y las dos acciones lo vuelven a mirar antes de tocar la
 * base o de llamar al modelo. El modo sin identidad lo decide tieneRol
 * (lib/workspace/rol.ts).
 */
export const puedeEditarElPerfil = (): Promise<boolean> => tieneRol(PUEDEN_EDITAR_PERFIL);
