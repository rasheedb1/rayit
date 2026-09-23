/**
 * Campañas · el reporte que abre la marca, sin sesión ni workspace
 * (PublicShareTx). Es la cuarta función pública del producto, con la
 * misma forma que las tres de queries/cotizar/publico.ts: no consulta
 * tablas, llama a public_report() (migración 0037), que corre como
 * mc_public_share y devuelve jsonb ya recortado.
 *
 * Parte de @mc/db/queries/campanas (la entrada es ../campanas.ts).
 */
import { isReportPayloadV1, type ReportPayload } from '@mc/core';
import type { PublicShareTx } from '../../client.ts';

/** Lo que la marca ve: el payload congelado más lo único vivo, el estado del enlace. */
export interface PublicReportView extends ReportPayload {
  slug: string;
  status: 'sent' | 'viewed';
  sentAt: string | null;
  viewedAt: string | null;
  /** El creador envió después una versión más reciente (0037 §1): este enlace sigue abriendo, con el aviso. */
  superseded: boolean;
  createdAt: string;
}

export type PublicReportResult =
  | { status: 'not_found' }
  /** La fila existe pero su payload es de una versión que este código no sabe pintar. */
  | { status: 'unsupported_version' }
  | { status: 'ok'; report: PublicReportView };

/** Qué cuenta como visita. La vista previa del creador y los robots que desenrollan enlaces, no. */
export interface PublicReportOptions {
  /** false: leer sin marcar el reporte como visto ni sumar visita. Por defecto, true. */
  count?: boolean;
}

/**
 * Abre un reporte por su enlace. Con `count` (por defecto), la primera
 * apertura deja status 'viewed' y viewed_at, y cada apertura suma una
 * visita. Un borrador y un slug desconocido responden igual: not_found.
 */
export async function readPublicReport(tx: PublicShareTx, slug: string, opts: PublicReportOptions = {}): Promise<PublicReportResult> {
  const { rows } = await tx.query<{ r: PublicReportResult }>('SELECT public_report($1, $2) AS r', [slug, opts.count ?? true]);
  const r = rows[0]?.r ?? { status: 'not_found' };
  if (r.status === 'ok' && !isReportPayloadV1(r.report)) return { status: 'unsupported_version' };
  return r;
}
