/**
 * Outreach · los avisos del motor (notification), en el idioma del
 * workspace (VEN-10 r2). Los textos viven en messages.ts; aquí se elige
 * el idioma por workspace.locale, se compone el aviso y se deduplica.
 */
import type { SqlExecutor } from '../../client.ts';
import { channelLabel, failureReason, noticeLang, OUTREACH_NOTICE_TEXTS } from './messages.ts';
import { assertIds } from './shared.ts';

/** Quién recibe el aviso: quien enroló (si sigue siendo del equipo), o todo el espacio (user_id NULL). */
const RECIPIENT_SQL = `(SELECT m.user_id FROM membership m
                         WHERE m.workspace_id = t.workspace_id AND m.user_id = e.enrolled_by AND m.role <> 'client')`;

/**
 * El aviso de un mensaje que no salió y no se va a reintentar (rebote,
 * cinco fallos, zombi, rechazo). Corre como mc_worker: el workspace es
 * el del toque, nunca otro.
 */
export async function notifyTouchFailed(tx: SqlExecutor, touchId: string, reason: string, now: Date): Promise<void> {
  assertIds('notifyTouchFailed', [touchId]);
  const r = (
    await tx.query<{ locale: string | null; company: string; contact: string | null; channel: string }>(
      `SELECT w.locale, co.name AS company, c.full_name AS contact, t.channel
         FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
        WHERE t.id = $1::uuid`,
      [touchId],
    )
  ).rows[0];
  if (!r) return;
  const lang = noticeLang(r.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT t.workspace_id, ${RECIPIENT_SQL}, 'outreach_failed', 'warning', $2, $3, 'outbound_touch', t.id, '/ventas', $4::timestamptz
       FROM outbound_touch t LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
      WHERE t.id = $1::uuid`,
    [
      touchId, m.failedTitle(r.company), m.failedBody(r.contact ?? r.company, channelLabel(lang, r.channel), failureReason(lang, reason)),
      now.toISOString(),
    ],
  );
}

/**
 * Un solo aviso por workspace, canal y día cuando la cuenta del canal no
 * está conectada (r2): no uno por mensaje. Los mensajes esperan en la
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
            '/ventas', $4::timestamptz
      WHERE NOT EXISTS (
              SELECT 1 FROM notification n
               WHERE n.workspace_id = $1::uuid AND n.kind = 'outreach_failed' AND n.entity_type = 'outreach_channel'
                 AND n.title_es = $2 AND n.created_at > $4::timestamptz - interval '20 hours')
     RETURNING id`,
    [input.workspaceId, title, m.accountDownBody(input.waiting, label), input.now.toISOString(), input.channel],
  );
  return r.rows.length > 0;
}
