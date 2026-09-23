import "server-only";
import type { WorkspaceTx } from "@mc/db";
import { getWorkspace } from "@mc/db/queries/cimientos";
import {
  acceptPublicQuote, completePublicAcceptance, type FirmaAceptacion, type PublicQuoteAcceptResult, type TextosCotizar,
} from "@mc/db/queries/cotizar";
import { getCurrentContext } from "@/lib/workspace/current";
import { closeDb as cerrarCliente, withPublicShare, withWorkspaceId } from "./cliente";

/**
 * La base de datos de la web y la ÚNICA forma en que una pantalla abre
 * una transacción: `withWorkspace(fn)`.
 *
 * El workspace y la identidad los pone lib/workspace/current.ts (la
 * sesión desde CIM-3, DEMO_WORKSPACE_ID solo como atajo de desarrollo)
 * y los fija el cliente DENTRO de la transacción: `app.workspace_id` y
 * `app.user_id`. Ninguna pantalla ni server action recibe ni pasa un
 * workspace_id; RLS hace el resto.
 *
 * Si algún día una pantalla necesita un catálogo, va con nombre en
 * `@mc/db/queries/catalogos`, no por el cliente crudo.
 */
/**
 * Los workspaces que ya se comprobó que existen en esta base, en este
 * proceso. Se vacía con closeDb: otra base, otra comprobación.
 */
const existentes = new Set<string>();

/**
 * Abre una transacción con el workspace y la identidad actuales fijados
 * y ejecuta fn.
 *
 * La PRIMERA vez que ve un workspace en el proceso, comprueba dentro de
 * la misma transacción que la fila exista (getWorkspace lanza «El
 * workspace … no existe en esta base» si no). Sin esto, un
 * DEMO_WORKSPACE_ID que no corresponde a ninguna fila se veía de dos
 * formas según el módulo: Finanzas y Ventas leen la fila workspace para
 * formatear y caían en su frontera, pero Campañas y Conexiones no la
 * leen y pintaban «Todavía no hay campañas» como si fuera un workspace
 * nuevo. Aquí se decide una vez, para todos los módulos —también para
 * el próximo—, y el error cae en la frontera del segmento (app).
 *
 * Con sesión (CIM-3) el workspace sale de membership y la fila existe;
 * la comprobación cuesta una consulta la primera vez y nada más. El
 * alta de un espacio (crearEspacio) no pasa por aquí: va por
 * withWorkspaceId de lib/db/cliente, así que la fila recién creada no
 * choca con la comprobación, y la siguiente pantalla ya la encuentra.
 *
 * La comprobación va aquí y no en el layout de (app) porque un error del
 * layout lo recoge la frontera del segmento PADRE, que ya no pinta el
 * Shell. Y se recuerda el éxito por proceso para no pagar una consulta
 * más en cada transacción.
 */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { workspaceId, identity } = await getCurrentContext();
  return withWorkspaceId(
    workspaceId,
    async (tx) => {
      if (!existentes.has(workspaceId)) {
        await getWorkspace(tx);
        existentes.add(workspaceId);
      }
      return fn(tx);
    },
    identity,
  );
}

/**
 * Una transacción SIN workspace, solo para los enlaces públicos de
 * Cotizar (/kit/<slug> y /cotizacion/<slug>).
 *
 * Es la única excepción a «toda pantalla abre withWorkspace», y está
 * acotada por los dos lados: quien la abre no tiene sesión —la marca
 * que recibió el enlace no es nadie en el producto—, y lo único que se
 * puede hacer con ella son las tres funciones SECURITY DEFINER de la
 * migración 0030, que corren como mc_public_share, reciben el slug y
 * devuelven jsonb ya recortado. Sobre cualquier tabla con RLS y
 * sin workspace fijado, esta transacción no ve NADA, ni siquiera
 * fijando a mano el parámetro del enlace: las políticas del enlace son
 * `TO mc_public_share`. Lo fijan «el permiso del enlace no sobrevive a
 * la llamada» y «la sonda» (packages/db/test/cotizar.test.ts).
 *
 * Es la operación con nombre `Db.withPublicShare` de @mc/db: su
 * transacción es un PublicShareTx, que solo aceptan las funciones
 * públicas de @mc/db/queries/cotizar, y la web no tiene que forzar el
 * tipo Db a CatalogDb para abrirla.
 */
export { withPublicShare } from "./cliente";

export type AceptacionDesdeEnlace =
  | Exclude<PublicQuoteAcceptResult, { status: "ok" }>
  | { status: "ok"; quoteNumber: string; campaignPending: boolean };

/**
 * «Aceptar cotización» desde el enlace público, de punta a punta (COT-4).
 *
 *   1. Sin workspace: public_quote_accept() deja la cotización aceptada
 *      con la firma y el negocio en «Ganado», y devuelve el workspace de
 *      ESA cotización. Es un dato que lee la base a partir del slug; el
 *      navegador no lo manda ni lo recibe.
 *   2. Con ese workspace fijado por el cliente de base (como cualquier
 *      withWorkspace): la actividad en el negocio, el aviso al creador y
 *      la campaña de CAM-2 (createCampaignFromQuote), sin un segundo clic.
 *
 * Son dos transacciones porque la primera no puede saber el workspace
 * antes de validar el slug. Si la segunda falla, la aceptación ya quedó
 * (es lo que la marca hizo) y el detalle del panel ofrece terminar la
 * campaña: CAM-2 es idempotente por quote_id.
 *
 * Es una operación con nombre, no un «withWorkspace(id)» suelto: la
 * web sigue sin poder abrir el workspace que quiera. `textos` son las
 * frases de messages.ts que quedan en la historia del negocio y en el
 * aviso al creador (@mc/db no escribe frases).
 */
export async function acceptQuoteFromLink(
  slug: string,
  firma: FirmaAceptacion,
  textos: TextosCotizar,
): Promise<AceptacionDesdeEnlace> {
  const r = await withPublicShare((tx) => acceptPublicQuote(tx, slug, firma));
  if (r.status !== "ok") return r;
  try {
    const campana = await withWorkspaceId(r.workspaceId, (tx) => completePublicAcceptance(tx, r.quoteId, textos));
    return { status: "ok", quoteNumber: r.quoteNumber, campaignPending: campana.campaign === null };
  } catch (err) {
    console.error("[cotizacion pública] aceptada, pero no se pudo terminar la campaña", err);
    return { status: "ok", quoteNumber: r.quoteNumber, campaignPending: true };
  }
}

export { getDbMode } from "./cliente";

/** Cierra la base del proceso. Solo para pruebas y para el apagado; una pantalla nunca la cierra. */
export async function closeDb(): Promise<void> {
  existentes.clear();
  await cerrarCliente();
}
