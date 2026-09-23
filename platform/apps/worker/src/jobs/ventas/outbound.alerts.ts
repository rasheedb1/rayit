/**
 * outbound.alerts · las alertas diarias del outreach (VEN-15).
 *
 * Una vez al día por workspace (el cron corre cada hora y cada workspace
 * se procesa desde las ALERTAS_HORA_LOCAL de su zona, como
 * sales.follow_ups), con la salud de las últimas 24 h:
 *
 *   outreach_bounce_rate   rebotes sobre el 5 %, con diez intentos o más
 *   outreach_no_sends      cero envíos con el envío encendido y enrolamientos activos
 *   outreach_queue_stuck   toques reclamados hace más de cinco minutos
 *   outreach_account_down  una cuenta de canal caída o por reconectar
 *   outreach_llm_budget    el presupuesto diario del modelo, agotado
 *
 * Qué está mal lo decide evaluateOutreachAlerts (@mc/core, puro); las
 * cifras salen de outbound_health (0037) y de outbound_bounce (0038):
 * ninguna resta se hace en una pantalla.
 *
 * Una notification por tipo y día LOCAL del workspace: si el tipo ya se
 * avisó hoy, no se repite aunque el job corra otra vez (la cola es
 * 'stately' y además hay un candado de transacción). Después, un correo
 * de resumen a cada dueño (membership.role = 'owner') con las alertas de
 * hoy que todavía no salieron por correo; al enviarlo se anota
 * notification.emailed_at. Si el correo falla o no hay SMTP_URL, quedan
 * sin marcar y salen en la corrida siguiente.
 *
 * Corre como mc_worker: cada fila lleva el workspace que la origina.
 */
import {
  evaluateOutreachAlerts, type AlertInput, type OutreachAlert, type OutreachAlertKind,
} from '@mc/core/outreach/deliverability';
import { parseOutboundHealth } from '@mc/db/queries/outreach';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';
import { smtpMailerFromEnv, type Mailer } from './correo.ts';

export const ALERTAS_JOB_ID = 'outbound.alerts';

/** Desde qué hora local del workspace se revisa. */
export const ALERTAS_HORA_LOCAL = 8;
/** La ventana de la salud, en horas. */
export const ALERTAS_VENTANA_H = 24;

/**
 * Los textos del aviso y del correo. El worker no tiene messages.ts: la
 * campana los recompone con kind si hace falta. Los `{n}` se rellenan con
 * cifras ya formateadas con Intl en el locale del workspace.
 */
export const ALERTAS_TEXTOS: Record<OutreachAlertKind, { title: string; body: string; url: string }> = {
  bounce_rate: {
    title: 'Rebotan demasiados correos: {rate}',
    body: '{bounces} de {attempts} correos rebotaron en las últimas 24 horas. Revisa las direcciones antes de seguir: Gmail castiga a quien rebota mucho.',
    url: '/ventas/politica',
  },
  no_sends: {
    title: 'El outreach no envió nada ayer',
    body: 'Hay {activeEnrollments} secuencias activas y no salió ningún mensaje en 24 horas. Revisa los canales y la cola.',
    url: '/ventas/politica',
  },
  queue_stuck: {
    title: 'Hay mensajes atascados en la cola',
    body: '{stuck} mensajes llevan más de cinco minutos enviándose. Si sigue así, revisa el canal.',
    url: '/ventas/politica',
  },
  account_down: {
    title: 'Una cuenta de envío necesita atención',
    body: '{accountsDown} cuentas de canal están caídas o piden reconectar. Mientras tanto no sale nada por ellas.',
    url: '/ventas/canales',
  },
  llm_budget: {
    title: 'Se agotó el presupuesto diario de redacción',
    body: 'Se gastaron {spentToday} de {dailyCap} hoy. Los mensajes nuevos esperan a mañana; lo aprobado sigue saliendo.',
    url: '/ventas/politica',
  },
};

export const ALERTAS_CORREO = {
  subject: 'On Cue · {n} alertas del outreach de {workspace}',
  subjectOne: 'On Cue · Una alerta del outreach de {workspace}',
  intro: 'Esto es lo que vimos hoy en el outreach de {workspace}:',
  outro: 'Ábrelo en On Cue: {url}',
} as const;

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

/** outbound_health (0037) y los rebotes de la ventana (0038), leídos de la base. */
export const readSignalsFromDb: ReadSignals = async (tx, workspaceId, now) => {
  const { rows } = await tx.query<{ h: unknown; rebotes: string | number; activos: string | number }>(
    `SELECT outbound_health($1::uuid, $2::int) AS h,
            (SELECT count(*) FROM outbound_bounce b
              WHERE b.workspace_id = $1 AND b.detected_at >= $3::timestamptz - make_interval(hours => $2::int)) AS rebotes,
            (SELECT count(*) FROM outbound_enrollment e WHERE e.workspace_id = $1 AND e.status = 'active') AS activos`,
    [workspaceId, ALERTAS_VENTANA_H, now.toISOString()],
  );
  const r = rows[0];
  const health = parseOutboundHealth(r?.h);
  const email = health.byChannel.email ?? { sent: 0, failed: 0 };
  return {
    health,
    emailAttempts: email.sent + email.failed,
    bounces: Number(r?.rebotes ?? 0),
    activeEnrollments: Number(r?.activos ?? 0),
  };
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
  const creadas: OutreachAlertKind[] = [];
  for (const a of alertas) {
    const t = ALERTAS_TEXTOS[a.kind];
    const valores = cifras(a, w.locale);
    const { rows } = await tx.query(
      `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, action_url, created_at)
       SELECT $1, NULL, $2, $3, $4, $5, $6, $7::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM notification n
           WHERE n.workspace_id = $1 AND n.kind = $2
             AND (n.created_at AT TIME ZONE $8)::date = ($7::timestamptz AT TIME ZONE $8)::date)
       RETURNING id`,
      [w.id, `outreach_${a.kind}`, a.severity, rellenar(t.title, valores), rellenar(t.body, valores), t.url, now.toISOString(), w.tz],
    );
    if (rows.length) creadas.push(a.kind);
  }
  return creadas;
}

type Pendiente = {
  id: string;
  title_es: string;
  body_es: string | null;
};

/** El resumen por correo de las alertas de hoy que no salieron todavía, a cada dueño. */
async function enviarResumen(db: JobDatabase, w: Espacio, now: Date, deps: AlertasDeps, r: AlertasResult): Promise<void> {
  const { rows: pendientes } = await db.query<Pendiente>(
    `SELECT id, title_es, body_es FROM notification
      WHERE workspace_id = $1 AND kind LIKE 'outreach\\_%' AND emailed_at IS NULL
        AND (created_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date
      ORDER BY created_at, kind`,
    [w.id, now.toISOString(), w.tz],
  );
  if (!pendientes.length) return;
  if (!deps.mailer) {
    r.emailSkipped++;
    return;
  }
  const { rows: duenos } = await db.query<{ email: string }>(
    `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.role = 'owner' AND u.deleted_at IS NULL ORDER BY u.email`,
    [w.id],
  );
  if (!duenos.length) return;
  const c = ALERTAS_CORREO;
  const subject =
    pendientes.length === 1
      ? rellenar(c.subjectOne, { workspace: w.name })
      : rellenar(c.subject, { n: new Intl.NumberFormat(w.locale).format(pendientes.length), workspace: w.name });
  const base = deps.appUrl.replace(/\/+$/, '');
  const text = [
    rellenar(c.intro, { workspace: w.name }),
    '',
    ...pendientes.flatMap((p) => [`· ${p.title_es}`, p.body_es ? `  ${p.body_es}` : '', '']),
    rellenar(c.outro, { url: `${base}/ventas/politica` }),
  ]
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n');
  try {
    for (const d of duenos) await deps.mailer.send({ to: d.email, subject, text });
  } catch (err) {
    r.emailFailed++;
    throw err;
  }
  await db.query('UPDATE notification SET emailed_at = $2 WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL', [
    pendientes.map((p) => p.id),
    now.toISOString(),
  ]);
  r.emailsSent += duenos.length;
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
