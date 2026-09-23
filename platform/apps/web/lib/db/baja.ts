import "server-only";
import { checkOptoutLink, optoutFromLink, type OptoutGates } from "@mc/db/queries/entregabilidad";
import { getMyIdentityAndWorkspaces } from "@mc/db/queries/identidad";
import { OPTOUT_SECRET_MIN_LENGTH } from "@mc/core/outreach/deliverability";
import { getSesion } from "@/lib/auth/session";
import { withIdentity, withPublicShare } from "./cliente";

/**
 * La baja desde el enlace de un correo (VEN-15): las dos operaciones con
 * nombre que usan la página pública /baja/<token> y el POST de un clic.
 *
 * Como los enlaces de Cotizar, quien abre esto no tiene por qué tener
 * sesión, y lo único que se escribe va por public_optout (SECURITY
 * DEFINER, 0037 §9). La diferencia: SI hay sesión, se mira a qué
 * espacios pertenece, porque el enlace también está en la carpeta de
 * enviados del creador y su propio clic no puede dar de baja a la marca
 * en toda la plataforma. Esa pregunta va por withIdentity (la misma que
 * responde «mis espacios» en cada petición), nunca por asWorker.
 *
 * El secreto que firma los tokens es OUTREACH_OPTOUT_SECRET, el mismo del
 * despachador. Sin él la página dice que el enlace no se puede comprobar
 * ahora, sin tocar la base: no hay forma de saber quién lo envió.
 */

export type EstadoEnlace =
  | { status: "valid" }
  | { status: "not_found" }
  | { status: "sender" }
  | { status: "unavailable" };

export type ResultadoBaja =
  | { status: "ok"; alreadyOptedOut: boolean }
  | { status: "not_found" }
  | { status: "sender" }
  | { status: "unavailable" };

function secreto(): string | null {
  const s = process.env.OUTREACH_OPTOUT_SECRET?.trim();
  return s && s.length >= OPTOUT_SECRET_MIN_LENGTH ? s : null;
}

/** Los espacios de quien abre el enlace, si tiene sesión. Sin Supabase Auth o sin sesión, ninguno. */
async function espaciosDeLaSesion(): Promise<readonly string[]> {
  const sesion = await getSesion();
  if (!sesion) return [];
  const mio = await withIdentity({ email: sesion.email }, (tx) => getMyIdentityAndWorkspaces(tx, sesion.authUserId));
  return mio ? mio.workspaces.map((w) => w.id) : [];
}

const puertas: OptoutGates = {
  withPublicShare,
  sessionWorkspaceIds: espaciosDeLaSesion,
};

/** Lo que la página puede decir antes del clic. No escribe nada. */
export async function estadoDelEnlaceDeBaja(token: string): Promise<EstadoEnlace> {
  const s = secreto();
  if (!s) return { status: "unavailable" };
  const r = await checkOptoutLink(puertas, token, s);
  return r.status === "valid" ? { status: "valid" } : r;
}

/** El clic: da de baja a la persona en toda la plataforma. */
export async function darDeBajaDesdeEnlace(token: string): Promise<ResultadoBaja> {
  const s = secreto();
  if (!s) return { status: "unavailable" };
  return optoutFromLink(puertas, token, s);
}
