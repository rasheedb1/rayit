/**
 * Outreach · los avisos del motor (notification), en el idioma del
 * workspace.
 *
 * Las frases no viven aquí: están en @mc/core/outreach/messages
 * (OUTREACH_NOTICE_TEXTS, los motivos de un fallo y de una retención, las
 * etiquetas de cada canal y las URL de cada aviso), el messages.ts del
 * motor, que leen también el worker y la web. Aquí solo se elige el
 * idioma por workspace.locale y se escribe la fila en la misma
 * transacción que la causa. notification guarda el texto en
 * title_es/body_es (el nombre de la columna es de 0002).
 */
import {
  channelLabel, failureReason, holdReasonText, noticeLang, OUTREACH_NOTICE_TEXTS, OUTREACH_URLS,
} from '@mc/core/outreach/messages';
import { INBOX_URLS } from '@mc/core/outreach/intent-messages';
import type { SqlExecutor } from '../../client.ts';
import { assertIds } from './shared.ts';

/**
 * Quién recibe el aviso: quien enroló (si sigue siendo del equipo), o todo
 * el espacio (user_id NULL). «Del equipo» lo decide la base
 * (membership_is_team, 0055), con y sin los roles de 0034_access_control.
 */
const RECIPIENT_SQL = `CASE WHEN membership_is_team(t.workspace_id, e.enrolled_by) THEN e.enrolled_by END`;

interface TouchNoticeRow {
  locale: string | null;
  company: string;
  company_id: string;
  contact: string | null;
  channel: string;
}

async function touchNoticeRow(tx: SqlExecutor, touchId: string): Promise<TouchNoticeRow | undefined> {
  return (
    await tx.query<TouchNoticeRow>(
      `SELECT w.locale, co.name AS company, co.id AS company_id, c.full_name AS contact, t.channel
         FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
        WHERE t.id = $1::uuid`,
      [touchId],
    )
  ).rows[0];
}

/**
 * El aviso de un mensaje que no salió y no se va a reintentar (rebote,
 * cinco fallos, zombi, rechazo). Lleva a la ficha de la empresa, donde
 * está el bloque «Mensajes de la cadencia», mientras no exista la cola de
 * VEN-16. Corre como mc_worker: el workspace es el del toque, nunca otro.
 */
export async function notifyTouchFailed(tx: SqlExecutor, touchId: string, reason: string, now: Date): Promise<void> {
  assertIds('notifyTouchFailed', [touchId]);
  const r = await touchNoticeRow(tx, touchId);
  if (!r) return;
  const lang = noticeLang(r.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT t.workspace_id, ${RECIPIENT_SQL}, 'outreach_failed', 'warning', $2, $3, 'outbound_touch', t.id, $5, $4::timestamptz
       FROM outbound_touch t LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
      WHERE t.id = $1::uuid`,
    [
      touchId, m.failedTitle(r.company),
      m.failedBody(r.contact ?? r.company, channelLabel(lang, r.channel), failureReason(lang, reason), r.company),
      now.toISOString(), OUTREACH_URLS.companyCadence(r.company_id),
    ],
  );
}

/**
 * El aviso de un mensaje RETENIDO (huecos sin rellenar, un intento
 * sin comprobar, una respuesta en el hilo sin correo previo, sin texto,
 * sin dirección postal, una nota de LinkedIn demasiado larga): sin él, un
 * mensaje retenido desaparecía en silencio, porque la cola que los
 * muestra (VEN-16) todavía no existe. Uno por mensaje y motivo: si el
 * mismo mensaje se retiene otra vez por lo mismo, no se repite; si se
 * aprobó y se retiene por OTRO motivo (una dirección postal que faltaba y
 * después un intento sin confirmar, que pide mirar la carpeta de
 * enviados), sí: el texto del aviso lleva el motivo, y se compara por él.
 * Es un 'outreach_failed' de
 * severidad info con entity_type 'outbound_touch_held' (no hace falta un
 * aviso nuevo en el CHECK de 0051 §9), y lleva al bloque «Mensajes de la
 * cadencia» de la ficha, donde el mensaje se revisa y se aprueba
 * (releaseHeldTouch).
 * `reason` es el código de held_reason; la frase sale de holdReasonText.
 */
export async function notifyTouchHeld(tx: SqlExecutor, touchId: string, reason: string, now: Date): Promise<boolean> {
  assertIds('notifyTouchHeld', [touchId]);
  const r = await touchNoticeRow(tx, touchId);
  if (!r) return false;
  const lang = noticeLang(r.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  const ins = await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT t.workspace_id, ${RECIPIENT_SQL}, 'outreach_failed', 'info', $2, $3, 'outbound_touch_held', t.id, $5, $4::timestamptz
       FROM outbound_touch t LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
      WHERE t.id = $1::uuid
        AND NOT EXISTS (SELECT 1 FROM notification n
                         WHERE n.workspace_id = t.workspace_id AND n.entity_type = 'outbound_touch_held' AND n.entity_id = t.id
                           AND n.body_es = $3)
     RETURNING id`,
    [
      touchId, m.heldTitle(r.company),
      m.heldBody(r.contact ?? r.company, channelLabel(lang, r.channel), holdReasonText(lang, reason)),
      // La bandeja de aprobación (VEN-14), abierta en su fila.
      now.toISOString(), `${INBOX_URLS.approvals}#fila-${touchId}`,
    ],
  );
  return ins.rows.length > 0;
}

/**
 * Un solo aviso por workspace, canal y día cuando la cuenta del canal no
 * está conectada: no uno por mensaje. Lleva a /ventas/canales,
 * donde está el botón de reconectar. Los mensajes esperan en la
 * cola (se posponen) y salen solos al reconectar. El «día» son las
 * últimas veinte horas: la corrida de mañana vuelve a avisar si sigue
 * caída. Devuelve si avisó.
 */
export async function notifyAccountDown(
  tx: SqlExecutor,
  input: { workspaceId: string; channel: string; waiting: number; now: Date },
): Promise<boolean> {
  assertIds('notifyAccountDown', [input.workspaceId]);
  const w = (await tx.query<{ locale: string | null }>(`SELECT locale FROM workspace WHERE id = $1::uuid`, [input.workspaceId])).rows[0];
  if (!w) return false;
  const lang = noticeLang(w.locale);
  const label = channelLabel(lang, input.channel);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  const title = m.accountDownTitle(label);
  const r = await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT $1::uuid, NULL, 'outreach_failed', 'warning', $2, $3, 'outreach_channel',
            (SELECT a.id FROM outreach_channel_account a
              WHERE a.workspace_id = $1::uuid AND a.channel = $5 ORDER BY a.updated_at DESC LIMIT 1),
            $6, $4::timestamptz
      WHERE NOT EXISTS (
              SELECT 1 FROM notification n
               WHERE n.workspace_id = $1::uuid AND n.kind = 'outreach_failed' AND n.entity_type = 'outreach_channel'
                 AND n.title_es = $2 AND n.created_at > $4::timestamptz - interval '20 hours')
     RETURNING id`,
    [input.workspaceId, title, m.accountDownBody(input.waiting, label), input.now.toISOString(), input.channel, OUTREACH_URLS.channels],
  );
  return r.rows.length > 0;
}
