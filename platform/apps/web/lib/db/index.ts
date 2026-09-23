import "server-only";
import type { WorkspaceTx } from "@mc/db";
import {
  acceptPublicQuote, completePublicAcceptance, type FirmaAceptacion, type PublicQuoteAcceptResult, type TextosCotizar,
} from "@mc/db/queries/cotizar";
import { getCurrentContext } from "@/lib/workspace/current";
import { withPublicShare, withWorkspaceId } from "./cliente";

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
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { workspaceId, identity } = await getCurrentContext();
  return withWorkspaceId(workspaceId, fn, identity);
}

/**
 * Una transacción SIN workspace, solo para los enlaces públicos de
 * Cotizar (/kit/<slug> y /cotizacion/<slug>).
 *
 * Es la única excepción a «toda pantalla abre withWorkspace», y está
 * acotada por los dos lados: quien la abre no tiene sesión —la marca
 * que recibió el enlace no es nadie en el producto—, y lo único que se
 * puede hacer con ella son las tres funciones SECURITY DEFINER de la
 * migración 0026, que corren como mc_public_share, reciben el slug y
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

export { closeDb, getDbMode } from "./cliente";
