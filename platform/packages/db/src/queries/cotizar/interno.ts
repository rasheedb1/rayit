/**
 * Cotizar · lo que las piezas de queries/cotizar/ comparten entre ellas
 * y NO es API: ../cotizar.ts no reexporta este archivo, así que nada de
 * aquí se ve desde @mc/db/queries/cotizar.
 */
import { validarRangoPrecio, type Decimal } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import type { MoveDealResult } from '../ventas.ts';
import type { QuoteDetail, TextosCotizar } from './cotizacion.ts';
import { MediaKitNotFound, RangoDeTarifaInvalido } from './errores.ts';

export function assertRango(low: Decimal | null, high: Decimal | null, deliverable: string | null): void {
  const motivo = validarRangoPrecio(low, high);
  if (motivo) throw new RangoDeTarifaInvalido(motivo, deliverable);
}

/**
 * El media kit que acompaña una cotización tiene que ser de su creador y
 * de este workspace (RLS). Uno de otro creador, o un id inventado, se
 * rechaza con MediaKitNotFound en vez de un error de clave ajena.
 */
export async function assertMediaKitDelCreador(tx: WorkspaceTx, mediaKitId: string | null | undefined, creatorId: string): Promise<void> {
  if (!mediaKitId) return;
  if (!isUuid(mediaKitId)) throw new MediaKitNotFound();
  const { rows } = await tx.query('SELECT 1 FROM media_kit WHERE id = $1 AND creator_id = $2', [mediaKitId, creatorId]);
  if (!rows[0]) throw new MediaKitNotFound();
}

/**
 * Una fila en la historia del negocio. `subject` es la frase ya
 * compuesta por la web; `metadata` lleva siempre `kind` y los
 * parámetros con los que se compuso.
 */
export async function registrarActividad(
  tx: WorkspaceTx,
  dealId: string,
  kind: 'proposal_sent' | 'stage_change' | 'note',
  subject: string,
  metadata: { kind: 'quote_sent' | 'quote_accepted' | 'deal_amount_from_quote' } & Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, kind, subject, occurred_at, metadata)
     SELECT current_workspace_id(), d.company_id, d.id, $2, $3, now(), $4::jsonb
       FROM deal d WHERE d.id = $1`,
    [dealId, kind, subject, JSON.stringify(metadata)],
  );
}

/** La actividad «aceptada» del negocio, desde el panel o desde el enlace. */
export async function registrarAceptacion(tx: WorkspaceTx, quote: QuoteDetail, via: 'panel' | 'enlace', textos: TextosCotizar): Promise<void> {
  if (!quote.dealId) return;
  const params = {
    quoteNumber: quote.number,
    signerName: quote.acceptedByName,
    signerEmail: quote.acceptedByEmail,
    via,
  };
  await registrarActividad(tx, quote.dealId, 'stage_change', textos.actividadAceptada(params), {
    kind: 'quote_accepted',
    quoteId: quote.id,
    ...params,
  });
}

/** La actividad «el monto del negocio pasó a ser el de la cotización», solo si cambió. */
export async function registrarCambioDeMonto(
  tx: WorkspaceTx,
  dealId: string,
  quote: Pick<QuoteDetail, 'id' | 'number'>,
  cambio: Pick<MoveDealResult, 'amountChanged' | 'amountFrom' | 'currencyFrom' | 'amountTo' | 'currencyTo'>,
  textos: TextosCotizar,
): Promise<void> {
  if (!cambio.amountChanged || cambio.amountTo === null) return;
  const params = {
    quoteNumber: quote.number,
    amountFrom: cambio.amountFrom,
    currencyFrom: cambio.currencyFrom,
    amountTo: cambio.amountTo,
    currencyTo: cambio.currencyTo,
  };
  await registrarActividad(tx, dealId, 'note', textos.actividadMonto(params), {
    kind: 'deal_amount_from_quote',
    quoteId: quote.id,
    ...params,
  });
}
