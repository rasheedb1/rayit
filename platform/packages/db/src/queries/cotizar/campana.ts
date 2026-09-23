/**
 * Cotizar · COT-4, el cruce con Campañas (CAM-2).
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import type { WorkspaceTx } from '../../client.ts';
import { createCampaignFromQuote } from '../campanas.ts';
import { acceptQuote, getQuote, type QuoteDetail, type TextosCotizar } from './cotizacion.ts';
import { CotizarError, QuoteNotFound } from './errores.ts';
import { registrarAceptacion } from './interno.ts';

// ---------------------------------------------------------------------
// COT-4 · El cruce con Campañas
// ---------------------------------------------------------------------

export interface CampanaDeCotizacion {
  campaignId: string;
  campaignName: string;
  /** false si la campaña ya existía: se devuelve esa, sin tocarla. */
  created: boolean;
}

/**
 * Crea la campaña de una cotización aceptada llamando a
 * `createCampaignFromQuote()` (CAM-2, queries/campanas.ts). Es la
 * dependencia D5 del backlog y el único punto donde Cotizar escribe en
 * la cadena de Campañas — indirectamente: esta función no inserta en
 * `campaign`, llama a la de Nicolás.
 *
 * Las fechas salen de lo acordado en la cotización
 * (campaign_starts_on / campaign_ends_on), que es lo que se pactó antes
 * de publicar; se pueden dar al llamar cuando la cotización se aceptó
 * sin ventana (el detalle ofrece entonces un formulario Desde/Hasta).
 * Sin ninguna de las dos, pide que se pacten en vez de inventarlas.
 *
 * El nombre es el del negocio («Paquete snacks · Q4») cuando lo hay: es
 * como el creador ya llama a ese trabajo, y describe mejor un paquete de
 * varios entregables que «marca · primer entregable», que es lo que CAM-2
 * pone por defecto.
 *
 * Es idempotente porque CAM-2 lo es: llamarla dos veces devuelve la
 * misma campaña con created: false.
 */
export async function createCampaignForQuote(
  tx: WorkspaceTx,
  quoteId: string,
  fechas: { startsOn?: string; endsOn?: string } = {},
): Promise<CampanaDeCotizacion> {
  const quote = await getQuote(tx, quoteId);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'accepted') {
    throw new CotizarError('QuoteNotAccepted', `Solo una cotización aceptada crea campaña; esta está en «${quote.status}».`);
  }
  const startsOn = fechas.startsOn ?? quote.campaignStartsOn;
  const endsOn = fechas.endsOn ?? quote.campaignEndsOn;
  if (!startsOn || !endsOn) {
    throw new CotizarError(
      'FechasDeCampanaFaltan',
      'Falta la ventana de la campaña. Acuérdala en la cotización (inicio y fin) antes de crearla.',
    );
  }
  if (endsOn < startsOn) {
    throw new CotizarError('FinAntesDeInicio', 'El fin de la campaña no puede ser anterior al inicio.');
  }
  const name = quote.dealName?.trim() || undefined;
  const { campaign, created } = await createCampaignFromQuote(tx, { quoteId: quote.id, startsOn, endsOn, name });
  return { campaignId: campaign.id, campaignName: campaign.name, created };
}

/** Lo que dejó una aceptación en Campañas: la campaña, o por qué quedó pendiente. */
export interface ResultadoCampana {
  campaign: CampanaDeCotizacion | null;
  /** El código del error si no se pudo crear (p. ej. 'FechasDeCampanaFaltan'); null si se creó. */
  pendingReason: string | null;
}

/**
 * Intenta crear la campaña DENTRO de la transacción de quien llama, sin
 * arriesgar lo demás: si CAM-2 la rechaza (faltan fechas, un conflicto),
 * se deshace solo su parte con un SAVEPOINT y la aceptación sigue en
 * pie. La cotización queda entonces con «Campaña: pendiente» y el
 * creador la termina desde el detalle.
 */
async function intentarCampana(tx: WorkspaceTx, quoteId: string): Promise<ResultadoCampana> {
  await tx.query('SAVEPOINT cotizar_campana');
  try {
    const campaign = await createCampaignForQuote(tx, quoteId);
    await tx.query('RELEASE SAVEPOINT cotizar_campana');
    return { campaign, pendingReason: null };
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT cotizar_campana');
    const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : 'CampaignError';
    return { campaign: null, pendingReason: code };
  }
}

/**
 * COT-4 desde el panel: aceptar y crear la campaña en UNA transacción.
 * Es lo que dice el criterio del backlog —«aceptar deja una campaña en
 * planned que Nicolás ve sin tocar nada»— sin un segundo clic.
 */
export async function acceptQuoteAndCreateCampaign(
  tx: WorkspaceTx,
  id: string,
  textos: TextosCotizar,
): Promise<{ quote: QuoteDetail } & ResultadoCampana> {
  await acceptQuote(tx, id, textos);
  const campana = await intentarCampana(tx, id);
  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  return { quote, ...campana };
}

/**
 * COT-4 desde el enlace: lo que queda después de `acceptPublicQuote`,
 * ya con el workspace de la cotización fijado por el cliente de base
 * (lib/db de la web lo abre con el workspaceId que devolvió la función
 * pública, nunca con uno que venga del navegador).
 *
 * Deja la actividad en el negocio, el aviso para el creador y la
 * campaña de CAM-2. Todo en la misma transacción; si la campaña no se
 * puede crear, el aviso lo dice y el detalle ofrece terminarla.
 */
export async function completePublicAcceptance(tx: WorkspaceTx, quoteId: string, textos: TextosCotizar): Promise<ResultadoCampana> {
  const quote = await getQuote(tx, quoteId);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'accepted') {
    throw new CotizarError('QuoteNotAccepted', `Solo una cotización aceptada crea campaña; esta está en «${quote.status}».`);
  }
  await registrarAceptacion(tx, quote, 'enlace', textos);
  const campana = await intentarCampana(tx, quoteId);
  const aviso = textos.avisoAceptada({
    companyName: quote.companyName,
    quoteNumber: quote.number,
    signerName: quote.acceptedByName,
    signerEmail: quote.acceptedByEmail,
    campaignName: campana.campaign?.campaignName ?? null,
  });
  await tx.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     VALUES (current_workspace_id(), 'quote_accepted', 'success', $1, $2, 'quote', $3, $4)`,
    [aviso.title, aviso.body, quote.id, `/cotizar/cotizaciones/${quote.id}`],
  );
  return campana;
}
