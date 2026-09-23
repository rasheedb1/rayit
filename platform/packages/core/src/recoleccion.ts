/**
 * Hasta cuándo se le siguen tomando lecturas a un post (CON-5).
 *
 * Es una regla de producto, no de base de datos, así que vive aquí:
 * pura, sin red y probada en milisegundos. La usa
 * `collect.post_metrics` para decidir a qué posts les toca snapshot
 * hoy; la consulta SQL solo hace el corte grueso.
 *
 * Dos razones para seguir midiendo, y solo dos:
 *
 *   1. El post es joven. «Joven» es hasta el corte más alto de
 *      scoring.ts (720 h = 30 días, el último de AGE_CUTS_HOURS) más
 *      una semana de gracia. La gracia existe porque
 *      `post_metrics_at_cut` toma el snapshot más cercano al corte SIN
 *      pasarse: si la última lectura fuera a las 719 h, el corte de
 *      720 h se quedaría con una lectura de casi un día antes.
 *
 *   2. El post está en una campaña abierta. Ahí manda la campaña: se
 *      mide hasta 30 días después de que termine, que es la ventana
 *      con la que CAM-5 cierra el resultado. Una campaña abierta sin
 *      fecha de fin se sigue midiendo mientras siga abierta.
 *
 * Fuera de eso, un post deja de acumular filas. No se borra nada: lo
 * ya medido se queda, y `post_metrics_daily_delta` sigue dibujando su
 * historia.
 */

import { daysBetween } from './facturacion.ts';
import { AGE_CUTS_HOURS } from './scoring.ts';

/** El corte de edad más alto que puntúa el producto (720 h). Sale de scoring.ts: si allí se agrega un corte, este tope sube solo. */
export const MAX_SCORING_CUT_HOURS: number = Math.max(...AGE_CUTS_HOURS);

/** Gracia después del último corte, para que ese corte tenga siempre una lectura posterior. */
export const COLLECTION_GRACE_HOURS = 7 * 24;

/** Edad máxima por defecto de un post que se sigue midiendo: 888 h. */
export const DEFAULT_MAX_AGE_HOURS: number = MAX_SCORING_CUT_HOURS + COLLECTION_GRACE_HOURS;

/** Estados de `campaign` en los que la campaña todavía necesita lecturas. */
export const OPEN_CAMPAIGN_STATUSES: readonly string[] = ['planned', 'live', 'measuring'];

/** Días después de `campaign.ends_on` en los que CAM-5 aún cierra el resultado. */
export const CAMPAIGN_TAIL_DAYS = 30;

export interface OpenCampaign {
  /** `campaign.status`. */
  status: string;
  /** `campaign.ends_on` como 'YYYY-MM-DD', o null si la campaña no tiene fecha de fin. */
  endsOn: string | null;
}

export interface KeepMeasuringInput {
  /** Edad del post en horas en el instante de la corrida. */
  ageHours: number;
  /** La campaña abierta a la que pertenece el post, si pertenece a alguna. */
  campaign?: OpenCampaign | null;
  /** El día de la corrida, 'YYYY-MM-DD' en UTC. Solo hace falta con campaña. */
  today?: string;
  /** Tope de edad; por defecto DEFAULT_MAX_AGE_HOURS. */
  maxAgeHours?: number;
}

export function isOpenCampaign(campaign: OpenCampaign | null | undefined): campaign is OpenCampaign {
  return campaign !== null && campaign !== undefined && OPEN_CAMPAIGN_STATUSES.includes(campaign.status);
}

/**
 * ¿Le toca snapshot a este post hoy?
 *
 * Un post sin edad conocida (NaN, porque no sabemos cuándo se publicó)
 * SÍ se mide: no saber cuándo se publicó no es saber que es viejo, y
 * dejarlo fuera lo condenaría a no tener nunca una lectura.
 */
export function shouldKeepMeasuring(input: KeepMeasuringInput): boolean {
  const maxAge = input.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(input.ageHours) || input.ageHours <= maxAge) return true;
  if (!isOpenCampaign(input.campaign)) return false;
  // Campaña abierta sin fecha de fin: se mide mientras siga abierta.
  if (input.campaign.endsOn === null) return true;
  if (input.today === undefined) return true;
  let desde: number;
  try {
    desde = daysBetween(input.campaign.endsOn, input.today);
  } catch {
    // Una fecha ilegible no puede sacar un post de la medición: lo
    // conservador es seguir midiendo y que se note en los datos.
    return true;
  }
  return desde <= CAMPAIGN_TAIL_DAYS;
}
