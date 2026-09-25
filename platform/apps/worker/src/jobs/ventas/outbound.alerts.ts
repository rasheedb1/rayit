/**
 * outbound.alerts · las alertas diarias del outreach (VEN-15).
 *
 * Una vez al día por workspace (el cron corre cada hora y cada workspace
 * se procesa desde las ALERTAS_HORA_LOCAL de su zona, como
 * sales.follow_ups), con la salud de las últimas 24 h:
 *
 *   outreach_bounce_rate   rebotes DUROS de lo enviado sobre el 5 %, con diez envíos o más
 *   outreach_no_sends      cero envíos con el envío encendido y toques que tocaba enviar
 *   outreach_queue_stuck   toques reclamados hace más de cinco minutos
 *   outreach_account_down  una cuenta de canal caída o por reconectar
 *   outreach_llm_budget    el presupuesto diario del modelo, agotado
 *
 * Qué está mal lo decide evaluateOutreachAlerts (@mc/core, puro); las
 * cifras salen de outbound_health (0037) y de readAlertSignalCounts
 * (@mc/db, la misma consulta que enseña /ventas/politica): ninguna resta
 * se hace en una pantalla.
 *
 * Una notification por tipo y día LOCAL del workspace: si el tipo ya se
 * avisó hoy, no se repite aunque el job corra otra vez (la cola es
 * 'stately' y además hay un candado de transacción). Cada una lleva su
 * propio enlace (messages.ts, ALERTAS_URL).
 *
 * Después, UN correo de resumen por workspace, a todos sus dueños
 * (membership_is_owner, 0055) a la vez, con las alertas que todavía no
 * salieron por correo; al enviarlo se anota notification.emailed_at. Uno
 * por workspace y no uno por dueño: si el envío falla no sale a nadie y
 * nada queda marcado, así que la corrida siguiente no le repite el
 * resumen a quien ya lo tenía. Sin SMTP_URL, o si el correo falla, las
 * alertas quedan sin marcar y salen con la siguiente corrida que pueda
 * enviar, aunque sea otro día, mientras tengan menos de
 * ALERTAS_REENVIO_DIAS: una semana sin correo no se convierte en un
 * resumen con alertas de hace un mes.
 *
 * Textos en el idioma del workspace (messages.ts). Corre como mc_worker:
 * cada fila lleva el workspace que la origina.
 */
import { evaluateOutreachAlerts, type AlertInput, type OutreachAlert, type OutreachAlertKind } from '@mc/core/outreach/deliverability';
import { HEALTH_WINDOW_H, readAlertSignalCounts } from '@mc/db/queries/entregabilidad';
import { parseOutboundHealth } from '@mc/db/queries/outreach';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';
import { smtpMailerFromEnv, type Mailer } from './correo.ts';
import { ALERTAS_URL, alertTextsFor } from './messages.ts';

export const ALERTAS_JOB_ID = 'outbound.alerts';

/** Desde qué hora local del workspace se revisa. */
export const ALERTAS_HORA_LOCAL = 8;
/** La ventana de la salud, en horas. */
export const ALERTAS_VENTANA_H = HEALTH_WINDOW_H;
/** Una alerta sin correo se sigue intentando mandar durante estos días. */
export const ALERTAS_REENVIO_DIAS = 7;

function rellenar(plantilla: string, valores: Readonly<Record<string, string>>): string {
  return plantilla.replace(/\{(\w+)\}/g, (_, k: string) => valores[k] ?? `{${k}}`);
}

/** Las cifras de la alerta, formateadas en el locale del workspace. */
function cifras(alerta: OutreachAlert, locale: string): Record<string, string> {
  const n = new Intl.NumberFormat(locale);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(alerta.values)) out[k] = n.format(v);
  if ('rate' in alerta.values) {
    out['rate'] = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(alerta.values['rate'] ?? 0);
  }
  if (alerta.kind === 'llm_budget') {
    const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
    out['spentToday'] = usd.format(alerta.values['spentToday'] ?? 0);
    out['dailyCap'] = usd.format(alerta.values['dailyCap'] ?? 0);
  }
  return out;
}

/** Las entradas de evaluateOutreachAlerts para un workspace. Se inyecta en las pruebas con fixtures. */
export type ReadSignals = (tx: Queryable, workspaceId: string, now: Date) => Promise<AlertInput>;

/** outbound_health (0037) y las cifras de la ventana (readAlertSignalCounts), leídas de la base. */
export const readSignalsFromDb: ReadSignals = async (tx, workspaceId, now) => {
  const { rows } = await tx.query<{ h: unknown }>('SELECT outbound_health($1::uuid, $2::int) AS h', [
    workspaceId,
    ALERTAS_VENTANA_H,
  ]);
  const health = parseOutboundHealth(rows[0]?.h);
  const c = await readAlertSignalCounts(tx, workspaceId, now, ALERTAS_VENTANA_H);
  return { health, emailsSent: c.emailsSent, hardBounces: c.hardBounces, dueToSend: c.dueToSend };
};

export interface AlertasDeps {
  /** null = sin SMTP_URL: no se envía el resumen. */
  mailer: Mailer | null;
  /** APP_URL, para el enlace del correo. */
  appUrl: string;
  readSignals?: ReadSignals;
  /** Hora local desde la que se revisa; 0 revisa a cualquier hora. */
  horaLocal?: number;
}

export interface AlertasResult {
  workspaces: number;
  /** Notificaciones nuevas, por tipo. */
  created: Partial<Record<OutreachAlertKind, number>>;
  /** Correos de resumen enviados: uno por workspace, a todos sus dueños. */
  emailsSent: number;
  /** Workspaces con alertas por enviar y sin SMTP_URL. */
  emailSkipped: number;
  emailFailed: number;
}

type Espacio = {
  id: string;
  name: string;
  tz: string;
  locale: string;
};

/**
 * Los workspaces con outreach (política, cuenta de canal o secuencia
 * activa) que ya pasaron su hora de revisión. La zona se valida contra
 * pg_timezone_names: una zona mal escrita cuenta en UTC y no tumba a los
 * demás (como en sales.follow_ups).
 */
async function espacios(db: Queryable, now: Date, hora: number): Promise<Espacio[]> {
  const { rows } = await db.query<Espacio>(
    `WITH zonas AS MATERIALIZED (SELECT name FROM pg_timezone_names)
     SELECT w.id, w.name, coalesce(z.name, 'UTC') AS tz, w.locale
       FROM workspace w
       LEFT JOIN zonas z ON z.name = w.timezone
      WHERE w.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM outbound_policy p WHERE p.workspace_id = w.id)
             OR EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.workspace_id = w.id AND a.status <> 'disconnected')
             OR EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.workspace_id = w.id AND e.status = 'active'))
        AND ($1::timestamptz AT TIME ZONE coalesce(z.name, 'UTC'))::time >= make_time($2::int, 0, 0)
      ORDER BY w.id`,
    [now.toISOString(), hora],
  );
  return rows;
}

/** Deja las notificaciones del día que falten. Devuelve los tipos creados. */
async function avisar(tx: Queryable, w: Espacio, alertas: OutreachAlert[], now: Date): Promise<OutreachAlertKind[]> {
  const textos = alertTextsFor(w.locale).alerts;
  const creadas: OutreachAlertKind[] = [];
  for (const a of alertas) {
    const t = textos[a.kind];
    const valores = cifras(a, w.locale);
    const { rows } = await tx.query(
      `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, action_url, created_at)
       SELECT $1, NULL, $2, $3, $4, $5, $6, $7::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM notification n
           WHERE n.workspace_id = $1 AND n.kind = $2
             AND (n.created_at AT TIME ZONE $8)::date = ($7::timestamptz AT TIME ZONE $8)::date)
       RETURNING id`,
      [
        w.id, `outreach_${a.kind}`, a.severity, rellenar(t.title, valores), rellenar(t.body, valores), ALERTAS_URL[a.kind],
        now.toISOString(), w.tz,
      ],
    );
    if (rows.length) creadas.push(a.kind);
  }
  return creadas;
}

type Pendiente = {
  id: string;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
};

/**
 * El resumen por correo de las alertas que no salieron todavía (de los
 * últimos ALERTAS_REENVIO_DIAS), en UN correo a todos los dueños.
 */
async function enviarResumen(db: JobDatabase, w: Espacio, now: Date, deps: AlertasDeps, r: AlertasResult): Promise<void> {
  const { rows: pendientes } = await db.query<Pendiente>(
    `SELECT id, title_es, body_es, action_url FROM notification
      WHERE workspace_id = $1 AND kind LIKE 'outreach\\_%' AND emailed_at IS NULL
        AND created_at >= $2::timestamptz - make_interval(days => $3::int)
      ORDER BY created_at, kind`,
    [w.id, now.toISOString(), ALERTAS_REENVIO_DIAS],
  );
  if (!pendientes.length) return;
  if (!deps.mailer) {
    r.emailSkipped++;
    return;
  }
  const { rows: duenos } = await db.query<{ email: string }>(
    `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND membership_is_owner(m.workspace_id, m.user_id) AND u.deleted_at IS NULL ORDER BY u.email`,
    [w.id],
  );
  if (!duenos.length) return;
  const c = alertTextsFor(w.locale).email;
  const subject =
    pendientes.length === 1
      ? rellenar(c.subjectOne, { workspace: w.name })
      : rellenar(c.subject, { n: new Intl.NumberFormat(w.locale).format(pendientes.length), workspace: w.name });
  const base = deps.appUrl.replace(/\/+$/, '');
  const text = [
    rellenar(c.intro, { workspace: w.name }),
    '',
    ...pendientes.flatMap((p) => [
      `· ${p.title_es}`,
      ...(p.body_es ? [`  ${p.body_es}`] : []),
      ...(p.action_url ? [`  ${rellenar(c.link, { url: `${base}${p.action_url}` })}`] : []),
      '',
    ]),
    c.outro,
  ].join('\n');
  try {
    await deps.mailer.send({ to: duenos.map((d) => d.email), subject, text });
  } catch (err) {
    r.emailFailed++;
    throw err;
  }
  await db.query('UPDATE notification SET emailed_at = $2 WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL', [
    pendientes.map((p) => p.id),
    now.toISOString(),
  ]);
  r.emailsSent++;
}

export async function runAlertas(
  db: JobDatabase,
  now: Date,
  deps: AlertasDeps,
  onError?: (workspaceId: string, err: unknown) => void,
): Promise<AlertasResult> {
  const hora = Math.max(0, Math.min(23, Math.trunc(deps.horaLocal ?? ALERTAS_HORA_LOCAL)));
  const leer = deps.readSignals ?? readSignalsFromDb;
  const r: AlertasResult = { workspaces: 0, created: {}, emailsSent: 0, emailSkipped: 0, emailFailed: 0 };
  for (const w of await espacios(db, now, hora)) {
    r.workspaces++;
    try {
      const creadas = await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ALERTAS_JOB_ID}/${w.id}`]);
        return avisar(tx, w, evaluateOutreachAlerts(await leer(tx, w.id, now)), now);
      });
      for (const k of creadas) r.created[k] = (r.created[k] ?? 0) + 1;
      await enviarResumen(db, w, now, deps, r);
    } catch (err) {
      onError?.(w.id, err);
    }
  }
  return r;
}

export function createAlertasJob(deps: Omit<AlertasDeps, 'mailer' | 'appUrl'> & { mailerFromEnv?: typeof smtpMailerFromEnv } = {}) {
  return defineJob(
    ALERTAS_JOB_ID,
    async (_payload, ctx) => {
      const mailer = (deps.mailerFromEnv ?? smtpMailerFromEnv)(ctx.env);
      const appUrl = ctx.env['APP_URL']?.trim() || 'http://localhost:3100';
      let fallos = 0;
      const r = await runAlertas(ctx.db, ctx.now(), { ...deps, mailer, appUrl }, (ws, err) => {
        fallos++;
        ctx.logger.warn('alertas de outreach: falló un workspace', { workspaceId: ws, error: err instanceof Error ? err.message : String(err) });
      });
      if (r.emailSkipped) ctx.logger.info('alertas de outreach: sin SMTP_URL, el resumen no salió', { workspaces: r.emailSkipped });
      const creadas = Object.values(r.created).reduce((a, b) => a + (b ?? 0), 0);
      return { processed: creadas, failed: fallos, metadata: { ...r } };
    },
    { retryOnItemFailure: false },
  );
}

export const alertasJob = createAlertasJob();
