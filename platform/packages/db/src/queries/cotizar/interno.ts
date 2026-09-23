/**
 * Cotizar · lo que las piezas de queries/cotizar/ comparten entre ellas
 * y NO es API: ../cotizar.ts no reexporta este archivo, así que nada de
 * aquí se ve desde @mc/db/queries/cotizar.
 */
import { validarRangoPrecio, type Decimal } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import type { MoveDealResult } from '../ventas.ts';
import type { QuoteDetail, TextosCotizar } from './cotizacion.ts';
import { MediaKitNotFound, OtraVersionEnCurso, RangoDeTarifaInvalido } from './errores.ts';

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

/**
 * Bloquea el negocio —DESPUÉS de la cotización, el orden de siempre
 * (ver getQuoteForUpdate)— y devuelve la OTRA cotización aceptada con
 * la que ya está ganado, o null.
 *
 * «Ganado con otra aceptada» y no solo «hay otra aceptada»: un negocio
 * ganado cuya campaña se cancela se puede reabrir (deal_move_stage,
 * 0031), y la versión que se negocie entonces se tiene que poder
 * aceptar; la aceptada vieja sigue siendo historia. Es la misma regla
 * que public_quote_accept_impl (0033) aplica desde el enlace.
 *
 * La segunda de dos aceptaciones a la vez espera aquí al bloqueo del
 * negocio y, cuando lo tiene, la consulta siguiente ya ve la primera.
 */
export async function aceptadaDelNegocio(tx: WorkspaceTx, dealId: string, quoteId: string): Promise<{ id: string; number: string } | null> {
  const { rows } = await tx.query<{ won_at: string | null }>('SELECT won_at FROM deal WHERE id = $1 FOR UPDATE', [dealId]);
  if (!rows[0] || rows[0].won_at === null) return null;
  const { rows: otra } = await tx.query<{ id: string; number: string }>(
    `SELECT id, number FROM quote
      WHERE deal_id = $1 AND id <> $2 AND status = 'accepted'
      ORDER BY accepted_at DESC NULLS LAST
      LIMIT 1`,
    [dealId, quoteId],
  );
  return otra[0] ?? null;
}

/**
 * Deja sin efecto las demás versiones VIVAS (enviadas o vistas) del
 * negocio: 'expired' con superseded_by = la que se envía o se acepta
 * (0033). Así un negocio tiene, en todo momento, como mucho una
 * cotización que la marca puede aceptar, y el detalle de las dos lo
 * dice («COT-2026-009 queda sin efecto»). Devuelve sus números.
 *
 * NOWAIT: si la marca está aceptando una de esas versiones en este
 * instante, public_quote_accept tiene su fila y espera la del negocio,
 * que ya es nuestra. Esperarla sería un bloqueo mutuo; se para con
 * OtraVersionEnCurso y quien envía recarga y ve cómo quedó.
 */
export async function dejarSinEfecto(tx: WorkspaceTx, dealId: string, quoteId: string): Promise<string[]> {
  let vivas: { id: string }[];
  try {
    ({ rows: vivas } = await tx.query<{ id: string }>(
      `SELECT id FROM quote
        WHERE deal_id = $1 AND id <> $2 AND status IN ('sent', 'viewed')
        FOR UPDATE NOWAIT`,
      [dealId, quoteId],
    ));
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '55P03') throw new OtraVersionEnCurso();
    throw err;
  }
  if (vivas.length === 0) return [];
  const { rows } = await tx.query<{ number: string }>(
    `UPDATE quote
        SET status = 'expired', expired_at = coalesce(expired_at, now()), superseded_by = $2
      WHERE id = ANY($1::uuid[]) AND status IN ('sent', 'viewed')
      RETURNING number`,
    [vivas.map((v) => v.id), quoteId],
  );
  return rows.map((r) => r.number).sort();
}
