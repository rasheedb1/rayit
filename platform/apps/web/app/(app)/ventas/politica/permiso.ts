import "server-only";
import { POLICY_MANAGER_ROLES } from "@mc/db/queries/entregabilidad";
import type { MembershipRole } from "@mc/db/queries/identidad";
import { tieneRol } from "@/lib/workspace/rol";

const PUEDEN_CAMBIAR_LA_POLITICA: ReadonlySet<MembershipRole> = new Set<MembershipRole>(POLICY_MANAGER_ROLES);

/**
 * Si quien mira puede cambiar la política de envío y encender o apagar
 * el envío automático: 'owner' o 'admin' del workspace actual (0038 §7).
 * La página lo usa para no ofrecer lo que la base rechazaría, y las
 * acciones lo vuelven a mirar antes de escribir; la última palabra es de
 * la base (políticas RESTRICTIVE de outbound_policy).
 *
 * Sin identidad, solo si no hay Supabase Auth (tieneRol): es la misma
 * bandera que lib/db fija en la base (app.auth_disabled), y sin ella la
 * base también dice que no (0038 §7, falla cerrada).
 */
export const puedeCambiarLaPolitica = (): Promise<boolean> => tieneRol(PUEDEN_CAMBIAR_LA_POLITICA);
