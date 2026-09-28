/**
 * Ventas · el seguimiento a una cotización enviada (VEN-3 con COT-3): la
 * siguiente acción que deja una propuesta. Dueño: Rasheed.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { type NEXT_ACTION_KINDS } from '../../schema/ventas.ts';
import { dueInBusinessDays } from './interno.ts';
import { PITCH_ACTION, PITCH_DUE_HOUR, WORKSPACE_TZ } from './radar.ts';

/** El texto de la siguiente acción que deja enviar una cotización, si la pantalla no da otro (respaldo, como PITCH_ACTION). */
export const FOLLOW_UP_ACTION = 'Seguimiento a la cotización';

/**
 * Qué es una siguiente acción que puso el producto (deal.next_action_kind,
 * 0032). NULL es una escrita por una persona: esa no la reemplaza nadie.
 * Un disparador la vuelve a NULL cuando alguien cambia el texto a mano.
 */
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/** Días HÁBILES (lunes a viernes) que se le dan al seguimiento de una cotización enviada. */
export const FOLLOW_UP_BUSINESS_DAYS = 3;

export interface FollowUpOptions {
  /** El texto de la siguiente acción nueva, en el idioma de la pantalla. Por defecto, FOLLOW_UP_ACTION. */
  followUpAction?: string;
  /**
   * Textos que también cuentan como el pitch, SOLO para los negocios sin
   * marcador (next_action_kind NULL): los que nacieron antes de 0032 y
   * las filas del seed. Lo normal es el marcador 'pitch', que no depende
   * del idioma; PITCH_ACTION siempre cuenta para esas filas viejas.
   */
  supersededActions?: readonly string[];
  /** Desde cuándo se cuentan los días hábiles. Por defecto, now() de la base; lo fijan las pruebas. */
  now?: Date;
}

/**
 * Enviar una cotización supera el pitch: el negocio queda en «Propuesta
 * enviada» y lo que sigue es hacerle seguimiento, no mandar un pitch que
 * ya se mandó con precio. Si la siguiente acción del negocio es el pitch
 * (next_action_kind = 'pitch', en el idioma que sea) o no tiene, pasa a
 * «Seguimiento a la cotización» (marcador 'quote_follow_up') a
 * FOLLOW_UP_BUSINESS_DAYS días hábiles, a las 15:00 en la zona del
 * workspace (dueInBusinessDays, la misma cuenta que el pitch). Una
 * acción que la persona escribió a mano («Llamar a Sofía») se respeta, y
 * un negocio cerrado no se toca. Devuelve si cambió algo.
 */
export async function followUpAfterProposal(
  tx: WorkspaceTx,
  dealId: string,
  opts: FollowUpOptions = {},
): Promise<boolean> {
  if (!isUuid(dealId)) return false;
  const superadas = [...new Set([PITCH_ACTION, ...(opts.supersededActions ?? [])].map((a) => a.trim()).filter(Boolean))];
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE deal d
        SET next_action = $2,
            next_action_kind = 'quote_follow_up',
            next_action_due = ${dueInBusinessDays('$6', '$4', '$5')},
            updated_at = now()
       FROM ${WORKSPACE_TZ} w, pipeline_stage st
      WHERE d.id = $1
        AND st.id = d.stage_id
        AND NOT st.is_won AND NOT st.is_lost
        AND (d.next_action IS NULL OR btrim(d.next_action) = ''
             OR d.next_action_kind = 'pitch'
             OR (d.next_action_kind IS NULL AND btrim(d.next_action) = ANY($3::text[])))
      RETURNING d.id`,
    [dealId, opts.followUpAction?.trim() || FOLLOW_UP_ACTION, superadas, FOLLOW_UP_BUSINESS_DAYS, PITCH_DUE_HOUR, opts.now?.toISOString() ?? null],
  );
  return rows.length > 0;
}
