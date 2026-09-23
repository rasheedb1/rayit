/**
 * finance.reminders · recordatorios de cobro (FIN-4).
 *
 * Cada día a las 10:00 UTC (job_definition de 0009), para cada factura
 * `sent` o `partial`, decide en qué paso está respecto a `due_on`
 * (−7, 0, +7, +21 y +45 días), redacta el correo con @mc/core y lo deja
 * como `notification` de tipo `invoice_overdue`, listo para copiar.
 *
 * **No envía nada.** El envío real por SMTP es fase 2 y depende de
 * CIM-10; cuando llegue, se manda solo el último paso de la corrida y
 * se marca `notification.emailed_at`.
 *
 * Idempotencia: una notificación por (factura, paso). El paso va
 * codificado en `action_url` (`…?recordatorio=<paso>`) y no en el
 * título, que es texto de producto y se va a reescribir. La cola es
 * `stately` (una corrida a la vez) y el INSERT lleva su propio
 * `WHERE NOT EXISTS`, así que una segunda corrida el mismo día no crea
 * nada. Detalle en docs/propuestas/FIN-4.md §0.4.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada SELECT, INSERT y
 * UPDATE lleva `workspace_id` explícito.
 */
import { definicionPaso, hoyEnZona, pasoDeUrl, pasosPendientes, redactarRecordatorio, urlRecordatorio, type DefinicionPaso } from '@mc/core';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';

export interface RecordatoriosPayload extends JobPayload {
  /** Solo esta factura (un envío manual desde la pantalla). */
  invoiceId?: string;
}

interface FacturaRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  number: string;
  currency: string;
  total: string;
  outstanding: string;
  due_on: string;
  reminders_sent: number;
  company_name: string;
  campaign_name: string | null;
  workspace_name: string;
  locale: string;
  timezone: string;
}

/**
 * Las facturas que pueden recibir un recordatorio: `paid`, `void` y
 * `draft` quedan fuera del SELECT, que es el mismo conjunto que
 * `deriveStatus` considera vencible.
 */
const FACTURAS = `
  SELECT i.id,
         i.workspace_id,
         i.number,
         i.currency,
         i.total::text                              AS total,
         (i.total - i.paid_amount)::text            AS outstanding,
         to_char(i.due_on, 'YYYY-MM-DD')            AS due_on,
         i.reminders_sent,
         co.name                                    AS company_name,
         ca.name                                    AS campaign_name,
         w.name                                     AS workspace_name,
         w.locale,
         w.timezone
    FROM invoice i
    JOIN company   co ON co.id = i.company_id
    JOIN workspace w  ON w.id  = i.workspace_id
    LEFT JOIN campaign ca ON ca.id = i.campaign_id
   WHERE i.status IN ('sent', 'partial')
     AND ($1::uuid IS NULL OR i.workspace_id = $1)
     AND ($2::uuid IS NULL OR i.id = $2)
   ORDER BY i.due_on, i.number`;

/** Los pasos que ya tienen su recordatorio escrito, por factura. */
async function emitidosPorFactura(ctx: JobContext, facturas: readonly FacturaRow[]): Promise<Map<string, number[]>> {
  const porFactura = new Map<string, number[]>();
  if (facturas.length === 0) return porFactura;
  const { rows } = await ctx.db.query<{ entity_id: string; action_url: string | null }>(
    // Las dos columnas van EMPAREJADAS, no como dos listas cruzadas: con
    // `workspace_id = ANY(…) AND entity_id = ANY(…)` una notificación de
    // otro workspace que apuntara a esta factura contaría como paso ya
    // emitido. Hoy nadie escribe una fila así, pero la consulta no tiene
    // por qué depender de eso.
    `SELECT entity_id, action_url
       FROM notification
      WHERE kind = 'invoice_overdue' AND entity_type = 'invoice'
        AND (workspace_id, entity_id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`,
    [facturas.map((f) => f.workspace_id), facturas.map((f) => f.id)],
  );
  for (const r of rows) {
    const paso = pasoDeUrl(r.action_url);
    if (paso !== null) porFactura.set(r.entity_id, [...(porFactura.get(r.entity_id) ?? []), paso]);
  }
  return porFactura;
}

/** Escribe un paso y dice si de verdad lo creó (false = ya estaba). */
async function escribirPaso(ctx: JobContext, f: FacturaRow, paso: DefinicionPaso, hoy: string): Promise<boolean> {
  const { asunto, cuerpo, severity } = redactarRecordatorio({
    paso: paso.numero,
    numero: f.number,
    empresa: f.company_name,
    campana: f.campaign_name,
    total: f.total,
    pendiente: f.outstanding,
    vencimiento: f.due_on,
    hoy,
    // La factura se emitió en SU moneda; el idioma es el del workspace.
    moneda: f.currency,
    locale: f.locale,
    nombreCreador: f.workspace_name,
    // Los datos de pago llegan con FIN-8; hasta entonces el texto dice
    // dónde se configuran en vez de dejar un hueco.
    datosDePago: null,
  });
  const url = urlRecordatorio(f.id, paso.numero);
  const { rowCount } = await ctx.db.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     SELECT $1::uuid, 'invoice_overdue', $2, $3, $4, 'invoice', $5::uuid, $6
      WHERE NOT EXISTS (
        SELECT 1 FROM notification
         WHERE workspace_id = $1::uuid AND kind = 'invoice_overdue'
           AND entity_type = 'invoice' AND entity_id = $5::uuid AND action_url = $6)`,
    [f.workspace_id, severity, asunto, cuerpo, f.id, url],
  );
  return rowCount > 0;
}

/**
 * `reminders_sent` = cuántos recordatorios existen para la factura, y
 * nunca baja: es un contador, no un puntero al último paso, para que el
 * número de la ficha y las filas de la bandeja siempre coincidan.
 */
async function sincronizarContador(ctx: JobContext, f: FacturaRow, ahora: Date): Promise<number> {
  const { rows } = await ctx.db.query<{ reminders_sent: number }>(
    `UPDATE invoice i
        SET reminders_sent = GREATEST(i.reminders_sent, c.n)::int,
            last_reminder_at = $3
       FROM (SELECT count(*) AS n
               FROM notification
              WHERE workspace_id = $2::uuid AND kind = 'invoice_overdue'
                AND entity_type = 'invoice' AND entity_id = $1::uuid) c
      WHERE i.id = $1::uuid AND i.workspace_id = $2::uuid
      RETURNING i.reminders_sent`,
    [f.id, f.workspace_id, ahora],
  );
  return rows[0]?.reminders_sent ?? f.reminders_sent;
}

export const recordatoriosJob = defineJob<RecordatoriosPayload>('finance.reminders', async (payload, ctx) => {
  const { rows: facturas } = await ctx.db.query<FacturaRow>(FACTURAS, [payload.workspaceId ?? null, payload.invoiceId ?? null]);
  const emitidos = await emitidosPorFactura(ctx, facturas);
  const ahora = ctx.now();

  const escritos: string[] = [];
  const saltadas: string[] = [];
  const fallidas: string[] = [];
  const porPaso: Record<string, number> = {};

  // Trabajo de base, no de red: no hay rate limit que repartir, así que
  // va en serie (max_concurrency de finance.reminders es 1) y así dos
  // facturas del mismo workspace no compiten por la misma fila.
  for (const f of facturas) {
    if (ctx.signal.aborted) {
      saltadas.push(f.id);
      continue;
    }
    const log = ctx.logger.child({ workspaceId: f.workspace_id, invoiceId: f.id, number: f.number });
    try {
      // El día es el del workspace: a las 10:00 UTC en Bogotá son las
      // 05:00, y una factura que vence "hoy" allá todavía no venció.
      const hoy = hoyEnZona(f.timezone, ahora);
      const pendientes = pasosPendientes({ dueOn: f.due_on, hoy, emitidos: emitidos.get(f.id) ?? [] });
      // Para emitir solo el más reciente por corrida: pendientes.slice(-1).
      if (pendientes.length === 0) {
        saltadas.push(f.id);
        continue;
      }
      let nuevos = 0;
      for (const paso of pendientes) {
        if (await escribirPaso(ctx, f, paso, hoy)) {
          nuevos += 1;
          porPaso[paso.numero] = (porPaso[paso.numero] ?? 0) + 1;
        }
      }
      if (nuevos === 0) {
        saltadas.push(f.id);
        continue;
      }
      const total = await sincronizarContador(ctx, f, ahora);
      escritos.push(f.id);
      log.info('recordatorios redactados', {
        pasos: pendientes.map((p) => p.numero),
        nuevos,
        remindersSent: total,
        etiquetas: pendientes.map((p) => definicionPaso(p.numero).etiquetaEs),
      });
    } catch (err) {
      fallidas.push(f.id);
      log.warn('no se pudo redactar el recordatorio de la factura', { err });
    }
  }

  return {
    processed: escritos.length + saltadas.length,
    failed: fallidas.length,
    // Ids y conteos: ni nombres de marcas, ni cifras, ni el texto del correo.
    metadata: {
      invoices: facturas.length,
      emitted: escritos.length,
      skipped: saltadas.length,
      failed: fallidas.length,
      byStep: porPaso,
      emittedIds: escritos,
      failedIds: fallidas,
    },
  };
});
