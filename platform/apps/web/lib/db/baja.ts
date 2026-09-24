import "server-only";
import { checkOptoutLink, optoutFromLink, type OptoutGates, type OptoutScope } from "@mc/db/queries/entregabilidad";
import { getMyIdentityAndWorkspaces } from "@mc/db/queries/identidad";
import { getSesion } from "@/lib/auth/session";
import { withIdentity, withPublicShare } from "./cliente";

/**
 * La baja desde el enlace de un correo (VEN-15): las dos operaciones con
 * nombre que usan la página pública /baja/<token> y el POST de un clic.
 *
 * Como los enlaces de Cotizar, quien abre esto no tiene por qué tener
 * sesión, y todo va por funciones SECURITY DEFINER de mc_public_share:
 * public_optout_preview (0038 §5) para lo que se enseña antes del clic y
 * public_optout (0037 §9, en dos tiempos desde 0038 §8) para la baja. El
 * token es opaco y lo decide su sha256 en la base: no hay secreto que
 * configurar ni que rotar, así que un error de configuración no puede
 * apagar la baja de la plataforma.
 *
 * SI hay sesión, se mira a qué espacios pertenece, porque el enlace
 * también está en la carpeta de enviados del creador: con su sesión, la
 * página no le ofrece el botón. Esa pregunta va por withIdentity (la
 * misma que responde «mis espacios» en cada petición), nunca por
 * asWorker; la respuesta la da la base, que sabe qué workspace envió el
 * correo.
 *
 * SIN sesión (una ventana privada, o un POST a mano a /un-clic) nadie
 * sabe quién pulsa. Por eso la baja vale primero solo para el workspace
 * que envió, y pasa a toda la plataforma cuando otro workspace la
 * confirma (0038 §8): el remitente que pulsa su propio enlace solo se da
 * de baja a sí mismo.
 */

export type EstadoEnlace =
  | { status: "valid"; maskedAddress: string; senderName: string | null; alreadyOptedOut: boolean }
  | { status: "not_found" }
  | { status: "sender" };

export type ResultadoBaja =
  | { status: "ok"; alreadyOptedOut: boolean; scope: OptoutScope }
  | { status: "not_found" }
  | { status: "sender" };

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
export function estadoDelEnlaceDeBaja(token: string): Promise<EstadoEnlace> {
  return checkOptoutLink(puertas, token);
}

/** El clic: vale ya para quien envió el correo, y para toda la plataforma cuando otro creador lo confirma. */
export function darDeBajaDesdeEnlace(token: string): Promise<ResultadoBaja> {
  return optoutFromLink(puertas, token);
}
