import "server-only";
import { createDbFromEnv, type Db, type DbMode, type PublicShareTx, type WorkspaceTx } from "@mc/db";
import {
  acceptPublicQuote, completePublicAcceptance, type FirmaAceptacion, type PublicQuoteAcceptResult, type TextosCotizar,
} from "@mc/db/queries/cotizar";
import { getCurrentWorkspaceId } from "@/lib/workspace/current";

/**
 * La base de datos de la web y la ÚNICA forma en que una pantalla abre
 * una transacción: `withWorkspace(fn)`.
 *
 * El cliente crudo NO sale de este módulo. Antes sí (`getDb()` devolvía
 * el `Db` entero) y con él una pantalla podía escribir
 * `db.asWorker(...)` y leer todos los workspaces saltándose RLS, o abrir
 * una transacción de catálogos sin querer. Nadie lo usaba fuera de la
 * prueba de este archivo, así que el ensanche de la costura no compraba
 * nada. Si algún día una pantalla necesita un catálogo, va con nombre
 * en `@mc/db/queries/catalogos`, no por el cliente crudo.
 *
 * El workspace lo pone lib/workspace/current.ts (DEMO_WORKSPACE_ID
 * hasta CIM-3, la sesión después) y lo fija el cliente dentro de la
 * transacción. Ninguna pantalla ni server action recibe ni pasa un
 * workspace_id.
 *
 * Se guarda en globalThis para sobrevivir a la recarga en caliente de
 * Next en desarrollo: sin esto, cada cambio de archivo levantaría otro
 * Postgres embebido.
 */
declare global {
  var __mcDb: Promise<{ db: Db; mode: DbMode }> | undefined;
}

function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcDb) {
    globalThis.__mcDb = createDbFromEnv().then((r) => {
      if (r.mode === "embedded") {
        console.warn(
          "[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo). " +
            "Para ver la base real: make db.unlock y vuelve a arrancar (el script dev de apps/web lee ../../.env.local).",
        );
      }
      return r;
    });
    globalThis.__mcDb.catch(() => {
      // Si falló al arrancar, que la próxima petición lo intente de nuevo.
      globalThis.__mcDb = undefined;
    });
  }
  return globalThis.__mcDb;
}

/** Abre una transacción con el workspace actual fijado y ejecuta fn. */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withWorkspace(getCurrentWorkspaceId(), fn);
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
export async function withPublicShare<T>(fn: (tx: PublicShareTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withPublicShare(fn);
}

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
  const { db } = await getDb();
  const r = await db.withPublicShare((tx) => acceptPublicQuote(tx, slug, firma));
  if (r.status !== "ok") return r;
  try {
    const campana = await db.withWorkspace(r.workspaceId, (tx) => completePublicAcceptance(tx, r.quoteId, textos));
    return { status: "ok", quoteNumber: r.quoteNumber, campaignPending: campana.campaign === null };
  } catch (err) {
    console.error("[cotizacion pública] aceptada, pero no se pudo terminar la campaña", err);
    return { status: "ok", quoteNumber: r.quoteNumber, campaignPending: true };
  }
}

/** Contra qué corre la web: 'postgres' (DATABASE_URL) o 'embedded' (modo demo). */
export async function getDbMode(): Promise<DbMode> {
  return (await getDb()).mode;
}

/** Cierra la base del proceso. Solo para pruebas y para el apagado; una pantalla nunca la cierra. */
export async function closeDb(): Promise<void> {
  const abierta = globalThis.__mcDb;
  globalThis.__mcDb = undefined;
  if (!abierta) return;
  const { db } = await abierta;
  await db.close();
}
