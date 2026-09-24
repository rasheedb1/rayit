/**
 * Outreach · los avisos del motor (notification), en el idioma del
 * workspace (VEN-10 r2).
 *
 * Un solo lugar para lo que la campana le dice a la persona: los títulos
 * y cuerpos por idioma, las etiquetas de cada canal y los motivos de un
 * fallo, en la voz del producto («mensaje», nunca la jerga interna
 * «toque»). notification guarda el texto en title_es/body_es (el nombre
 * de la columna es de 0002); aquí se elige por workspace.locale, como el
 * pie de baja del despachador.
 */
import type { SqlExecutor } from '../../client.ts';
import { assertIds } from './shared.ts';

export type NoticeLang = 'es' | 'en';

/** 'es-CO' → es, 'en-US' → en; lo que no se conoce, es. */
export function noticeLang(locale: string | null | undefined): NoticeLang {
  return (locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

/** Cómo se llama cada canal para una persona. */
export const CHANNEL_LABELS: Record<NoticeLang, Record<string, string>> = {
  es: { email: 'correo', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
  en: { email: 'email', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
};

export function channelLabel(lang: NoticeLang, channel: string): string {
  return CHANNEL_LABELS[lang][channel] ?? channel;
}

/** Por qué no salió un mensaje, en palabras. Lo que no está aquí se dice de forma genérica. */
export const FAILURE_REASON_TEXTS: Record<NoticeLang, Record<string, string>> = {
  es: {
    account_unavailable: 'la cuenta del canal no está conectada',
    account_auth: 'la cuenta del canal perdió el permiso y hay que reconectarla',
    bounced: 'el correo rebotó',
    invalid_recipient: 'la dirección no es válida',
    rejected: 'el proveedor lo rechazó',
    max_attempts: 'fallaron los cinco intentos',
    zombie: 'el envío quedó a medias y no se reintenta para no duplicarlo',
    not_configured: 'el canal no está configurado en la plataforma',
  },
  en: {
    account_unavailable: 'the channel account is not connected',
    account_auth: 'the channel account lost its permission and needs to be reconnected',
    bounced: 'the email bounced',
    invalid_recipient: 'the address is not valid',
    rejected: 'the provider rejected it',
    max_attempts: 'all five attempts failed',
    zombie: 'the send was interrupted and is not retried to avoid a duplicate',
    not_configured: 'the channel is not configured on the platform',
  },
};

export function failureReason(lang: NoticeLang, code: string): string {
  return FAILURE_REASON_TEXTS[lang][code] ?? (lang === 'en' ? 'the provider returned an error' : 'el proveedor devolvió un error');
}

/** Los textos de cada aviso, por idioma. */
export const OUTREACH_NOTICE_TEXTS = {
  es: {
    failedTitle: (company: string) => `Un mensaje a ${company} no salió`,
    failedBody: (who: string, channel: string, reason: string) =>
      `El mensaje a ${who} por ${channel} no se envió: ${reason}. Revisa la cola de Ventas.`,
    replyTitle: (who: string) => `${who} respondió`,
    replyBody: (channel: string) => `Llegó una respuesta por ${channel}. Lo pendiente de esa cadencia se canceló.`,
    optOutTitle: (who: string) => `${who} pidió no recibir más mensajes`,
    optOutBody: () => 'Se marcó la baja: nadie en la plataforma le volverá a escribir.',
    accountDownTitle: (channel: string) => `Tu cuenta de ${channel} no está conectada`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'Un mensaje espera' : `${count} mensajes esperan`} a que reconectes tu cuenta de ${channel}. ` +
      'Salen solos en cuanto vuelva a estar conectada.',
  },
  en: {
    failedTitle: (company: string) => `A message to ${company} was not sent`,
    failedBody: (who: string, channel: string, reason: string) =>
      `The message to ${who} over ${channel} was not sent: ${reason}. Check the Sales queue.`,
    replyTitle: (who: string) => `${who} replied`,
    replyBody: (channel: string) => `A reply came in over ${channel}. What was pending in that cadence was canceled.`,
    optOutTitle: (who: string) => `${who} asked not to be contacted again`,
    optOutBody: () => 'The opt-out was recorded: no one on the platform will write to them again.',
    accountDownTitle: (channel: string) => `Your ${channel} account is not connected`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'One message is' : `${count} messages are`} waiting for you to reconnect your ${channel} account. ` +
      'They go out on their own once it is connected again.',
  },
} as const;

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
