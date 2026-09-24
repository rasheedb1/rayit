/**
 * Outreach · una dirección de correo que no existe (VEN-10 r4, con VEN-15).
 *
 * Dos caminos llegan a saber que un correo rebotó para siempre, y los dos
 * dejan lo mismo en la base con estas funciones:
 *
 *   · el envío mismo lo devuelve (Gmail o Unipile responden
 *     invalid_recipient o bounced al enviar): recordFailure → stopForBadAddress;
 *   · el aviso llega después al buzón (mailer-daemon): el job
 *     outbound.bounces de VEN-15.
 *
 * Qué dejan:
 *   1. contact.email_invalid (con la fecha, el motivo y bounced), solo si
 *      la ficha SIGUE teniendo esa dirección: si alguien ya la corrigió, el
 *      rebote es de la vieja. Con la marca, 0050 §2 impide programarle un
 *      correo y enrollContacts salta sus pasos de correo, en cualquier
 *      secuencia y workspace que la tenga;
 *   2. los correos pendientes de esa ficha (draft, scheduled, held)
 *      cancelados con blocked_reason 'email_invalid'. Lo que está en
 *      processing es del despachador (0037 §4.1). LinkedIn e Instagram
 *      siguen: un rebote dice que la dirección no existe, no que la persona
 *      pidió no ser contactada (por eso tampoco va a contact_suppression);
 *   3. cada enrolamiento que se queda sin nada vivo termina en 'bounced'
 *      (0051 §7), no en 'completed' ni 'active' para siempre.
 */
import type { SqlExecutor } from '../../client.ts';
import { assertIds } from './shared.ts';

export interface EmailInvalidResult {
  /** Esta llamada puso la marca (false si ya estaba, o si la ficha ya tiene otra dirección). */
  invalidated: boolean;
  /** La ficha queda con la marca (la puso esta llamada o ya estaba). */
  isInvalid: boolean;
  /** Los correos pendientes que se cancelaron, con su enrolamiento. */
  canceled: Array<{ id: string; enrollmentId: string | null }>;
}

/**
 * Marca el correo de la ficha como inválido y cancela sus correos
 * pendientes (ver la cabecera). `address`: la dirección que rebotó; null
 * si el aviso no la trae (entonces se marca la que tenga la ficha).
 * `reason`: el diagnóstico del servidor o el código del proveedor.
 */
export async function markContactEmailInvalid(
  tx: SqlExecutor,
  input: { contactId: string; address: string | null; reason: string; now: Date },
): Promise<EmailInvalidResult> {
  assertIds('markContactEmailInvalid', [input.contactId]);
  const marca = await tx.query(
    `UPDATE contact
        SET email_invalid = true, email_invalid_at = $2::timestamptz, email_invalid_reason = left($3, 300), bounced = true
      WHERE id = $1::uuid AND NOT email_invalid AND ($4::citext IS NULL OR email = $4::citext)
      RETURNING id`,
    [input.contactId, input.now.toISOString(), input.reason || 'bounced', input.address],
  );
  const isInvalid = (
    await tx.query<{ email_invalid: boolean }>('SELECT email_invalid FROM contact WHERE id = $1::uuid', [input.contactId])
  ).rows[0]?.email_invalid === true;
  if (!isInvalid) return { invalidated: false, isInvalid: false, canceled: [] };
  const canceled = (
    await tx.query<{ id: string; enrollment_id: string | null }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'email_invalid'
        WHERE contact_id = $1::uuid AND channel = 'email' AND status IN ('draft', 'scheduled', 'held')
        RETURNING id, enrollment_id`,
      [input.contactId],
    )
  ).rows.map((r) => ({ id: r.id, enrollmentId: r.enrollment_id }));
  return { invalidated: marca.rows.length > 0, isInvalid: true, canceled };
}

/**
 * Los enrolamientos vivos que se quedaron sin ningún toque vivo por un
 * rebote terminan en 'bounced'. Devuelve cuántos.
 */
export async function finishBouncedEnrollments(tx: SqlExecutor, enrollmentIds: readonly string[], now: Date): Promise<number> {
  const ids = [...new Set(enrollmentIds)];
  if (ids.length === 0) return 0;
  assertIds('finishBouncedEnrollments', ids);
  const r = await tx.query(
    `UPDATE outbound_enrollment e SET status = 'bounced', finished_at = $2::timestamptz
      WHERE e.id = ANY($1::uuid[]) AND e.status IN ('active', 'paused', 'cooldown')
        AND NOT EXISTS (SELECT 1 FROM outbound_touch t
                         WHERE t.enrollment_id = e.id AND t.status IN ('draft', 'scheduled', 'processing', 'held'))
      RETURNING e.id`,
    [ids, now.toISOString()],
  );
  return r.rows.length;
}
