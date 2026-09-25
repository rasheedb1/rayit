/**
 * outbound.alerts · las alertas diarias del outreach (VEN-15).
 *
 * Cada hora, por workspace, desde las ALERTAS_HORA_LOCAL de su zona
 * (como sales.follow_ups), con la salud de las últimas 24 h:
 *
 *   outreach_bounce_rate   rebotes DUROS de lo enviado sobre el 5 %, con diez envíos o más
 *   outreach_no_sends      cero envíos con el envío encendido y toques que tocaba enviar
 *   outreach_queue_stuck   toques reclamados hace más de cinco minutos
 *   outreach_account_down  una cuenta de canal caída o por reconectar
 *   outreach_llm_budget    el presupuesto diario del modelo, agotado
 *   outreach_bounces_unread un Gmail conectado cuyo buzón de rebotes no se
 *                          lee (nunca, o hace más de BOUNCES_STALE_H):
 *                          «ningún rebote» no quiere decir «todo llegó» (r5)
 *
 * Qué está mal lo decide evaluateOutreachAlerts (@mc/core, puro); las
 * cifras salen de outbound_health (0037) y de readAlertSignalCounts
 * (@mc/db, la misma consulta que enseña /ventas/politica): ninguna resta
 * se hace en una pantalla.
 *
 * Una notification por tipo y día LOCAL del workspace: si el tipo ya se
 * avisó hoy, no se repite aunque el job corra otra vez (la cola es
 * 'stately' y además hay un candado de transacción; otro, el del correo,
 * cubre leer, enviar y marcar el resumen). Cada una lleva su
 * propio enlace (messages.ts, ALERTAS_URL).
 *
 * Después, UN correo de resumen por workspace y por DÍA LOCAL (r4), a
 * todos sus dueños (membership_is_owner, 0055) a la vez, con las alertas
 * que todavía no salieron por correo; al enviarlo se anota
 * notification.emailed_at, y esa misma columna dice si hoy ya salió uno.
 * Sale en la primera corrida del día que tenga algo que contar. Lo que
 * aparezca más tarde se reparte así (r5):
 *   · lo URGENTE (URGENT_ALERT_KINDS: una cuenta caída, los rebotes
 *     disparados) sale por correo en esa misma corrida, en un correo
 *     corto aparte: una cuenta de Gmail que cae a las 15:00 no puede
 *     esperar a mañana, y la web todavía no tiene una campana (las
 *     notification del outreach se leen en el correo y arriba de «Salud
 *     de hoy», listTodayOutreachAlerts). Como hay una notification por tipo y día,
 *     son como mucho dos correos urgentes al día;
 *   · lo demás va en el resumen del día siguiente.
 * Uno por workspace y no uno por dueño: si el envío falla no sale a nadie
 * y nada queda marcado, así que la corrida siguiente no le repite el
 * resumen a quien ya lo tenía. Sin SMTP_URL, o si el correo falla, las
 * alertas quedan sin marcar y salen con la siguiente corrida que pueda
 * enviar, aunque sea otro día, mientras tengan menos de
 * ALERTAS_REENVIO_DIAS: una semana sin correo no se convierte en un
 * resumen con alertas de hace un mes. Sin APP_URL el resumen sale igual,
 * pero sin enlaces (uno a localhost sería un enlace roto) y con una línea
 * que dice dónde verlo; el job lo avisa en el registro.
 *
 * La alerta de cuenta caída dice CUÁL es («LinkedIn: Laura · Cocina
 * fácil») y lleva a /ventas/politica#cuentas, donde está lo que dijo el
 * proveedor.
 *
 * Textos en el idioma del workspace (messages.ts), con los plurales de
 * Intl.PluralRules («1 mensaje lleva…», «3 mensajes llevan…»). Corre como mc_worker:
 * cada fila lleva el workspace que la origina.
 */
import {
  channelAccountLabel, evaluateOutreachAlerts, URGENT_ALERT_KINDS, type AlertInput, type OutreachAlert, type OutreachAlertKind,
} from '@mc/core/outreach/deliverability';
import { HEALTH_WINDOW_H, readAlertSignalCounts } from '@mc/db/queries/entregabilidad';
import { parseOutboundHealth } from '@mc/db/queries/outreach';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';
import { smtpMailerFromEnv, type Mailer } from './correo.ts';
import { ALERTAS_URL, alertTextsFor, fillTemplate } from './messages.ts';

export const ALERTAS_JOB_ID = 'outbound.alerts';

/** Desde qué hora local del workspace se revisa. */
export const ALERTAS_HORA_LOCAL = 8;
/** La ventana de la salud, en horas. */
export const ALERTAS_VENTANA_H = HEALTH_WINDOW_H;
/** Una alerta sin correo se sigue intentando mandar durante estos días. */
export const ALERTAS_REENVIO_DIAS = 7;

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
  return {
    health,
    emailsSent: c.emailsSent,
    hardBounces: c.hardBounces,
    dueToSend: c.dueToSend,
    unreadMailboxes: c.unreadMailboxes,
  };
};

export interface AlertasDeps {
  /** null = sin SMTP_URL (o sin MAIL_FROM en producción): no se envía el resumen. */
  mailer: Mailer | null;
  /** Por qué no hay cartero, para el resultado y el registro. */
  mailerMissing?: 'SMTP_URL' | 'MAIL_FROM' | null;
  /**
   * APP_URL, para el enlace de cada alerta en el correo. null = sin
   * APP_URL: el resumen sale sin enlaces (uno a localhost sería un enlace
   * roto en un despliegue mal configurado) y dice dónde verlo.
   */
  appUrl: string | null;
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
  /** Workspaces con alertas por enviar y sin cartero. */
  emailSkipped: number;
  /** Por qué no hubo cartero: falta SMTP_URL, o MAIL_FROM en producción. */
  emailSkippedReason: 'SMTP_URL' | 'MAIL_FROM' | null;
  emailFailed: number;
  /** Workspaces con alertas sin correo que esperan al resumen de mañana: hoy ya salió uno. */
  emailDeferred: number;
  /** Correos inmediatos de alertas urgentes que aparecieron después del resumen del día (r5). */
  urgentSent: number;
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

/**
 * Cuáles son las cuentas caídas, para que la alerta lo diga («LinkedIn:
 * Laura · Cocina fácil»), en una lista con Intl.ListFormat del locale del
 * workspace. Si la salud no viene de la base (un fixture) y no hay filas,
 * el número.
 */
async function cuentasCaidas(tx: Queryable, w: Espacio, cuantas: number): Promise<string> {
  const t = alertTextsFor(w.locale).accounts;
  const n = new Intl.NumberFormat(w.locale);
  const { rows } = await tx.query<{ channel: keyof typeof t.channel; name: string }>(
    `SELECT channel, coalesce(nullif(btrim(display_name), ''), provider_account_id) AS name
       FROM outreach_channel_account
      WHERE workspace_id = $1 AND status IN ('needs_reconnect', 'error')
      ORDER BY channel, id`,
    [w.id],
  );
  if (!rows.length) {
    return fillTemplate(t.unnamed, { accountsDown: n.format(cuantas) }, { accountsDown: cuantas }, w.locale);
  }
  // Sin repetir el canal si el nombre ya lo dice («Laura (LinkedIn)»).
  const nombres = rows.map((r) => channelAccountLabel(t.channel[r.channel] ?? r.channel, r.name));
  return new Intl.ListFormat(w.locale, { style: 'long', type: 'conjunction' }).format(nombres);
}

/** Deja las notificaciones del día que falten. Devuelve los tipos creados. */
async function avisar(tx: Queryable, w: Espacio, alertas: OutreachAlert[], now: Date): Promise<OutreachAlertKind[]> {
  const textos = alertTextsFor(w.locale).alerts;
  const creadas: OutreachAlertKind[] = [];
  for (const a of alertas) {
    const t = textos[a.kind];
    const valores = cifras(a, w.locale);
    if (a.kind === 'account_down') valores['accounts'] = await cuentasCaidas(tx, w, a.values['accountsDown'] ?? 0);
    const { rows } = await tx.query(
      `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, action_url, created_at)
       SELECT $1, NULL, $2, $3, $4, $5, $6, $7::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM notification n
           WHERE n.workspace_id = $1 AND n.kind = $2
             AND (n.created_at AT TIME ZONE $8)::date = ($7::timestamptz AT TIME ZONE $8)::date)
       RETURNING id`,
      [
        w.id, `outreach_${a.kind}`, a.severity, fillTemplate(t.title, valores, a.values, w.locale),
        fillTemplate(t.body, valores, a.values, w.locale), ALERTAS_URL[a.kind], now.toISOString(), w.tz,
      ],
    );
    if (rows.length) creadas.push(a.kind);
  }
  return creadas;
}

type Pendiente = {
  id: string;
  kind: string;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
};

/** Las notification de las alertas urgentes (outreach_account_down…), por su kind. */
const KINDS_URGENTES = new Set(URGENT_ALERT_KINDS.map((k) => `outreach_${k}`));

/**
 * El resumen por correo de las alertas que no salieron todavía (de los
 * últimos ALERTAS_REENVIO_DIAS), en UN correo a todos los dueños (en Cco:
 * ninguno ve la dirección de los demás), y como
 * mucho uno por día local del workspace. Si hoy ya salió, las urgentes
 * pendientes salen ahora en un correo aparte (r5) y las demás esperan.
 */
async function enviarResumen(db: Queryable, w: Espacio, now: Date, deps: AlertasDeps, r: AlertasResult): Promise<void> {
  // ¿Hoy (día local) ya salió un resumen? Lo dice emailed_at, que se anota
  // al enviarlo: sin tabla aparte que se pueda desincronizar.
  const { rows: [hoy] } = await db.query<{ ya: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM notification
        WHERE workspace_id = $1 AND kind LIKE 'outreach\\_%' AND emailed_at IS NOT NULL
          AND (emailed_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date) AS ya`,
    [w.id, now.toISOString(), w.tz],
  );
  const { rows: pendientes } = await db.query<Pendiente>(
    `SELECT id, kind, title_es, body_es, action_url FROM notification
      WHERE workspace_id = $1 AND kind LIKE 'outreach\\_%' AND emailed_at IS NULL
        AND created_at >= $2::timestamptz - make_interval(days => $3::int)
      ORDER BY created_at, kind`,
    [w.id, now.toISOString(), ALERTAS_REENVIO_DIAS],
  );
  if (!pendientes.length) return;
  // Hoy ya hubo resumen: solo lo urgente sale ya; lo demás, mañana.
  const urgente = Boolean(hoy?.ya);
  const aEnviar = urgente ? pendientes.filter((p) => KINDS_URGENTES.has(p.kind)) : pendientes;
  if (urgente && aEnviar.length < pendientes.length) r.emailDeferred++;
  if (!aEnviar.length) return;
  if (!deps.mailer) {
    r.emailSkipped++;
    r.emailSkippedReason = deps.mailerMissing ?? 'SMTP_URL';
    return;
  }
  const { rows: duenos } = await db.query<{ email: string }>(
    `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND membership_is_owner(m.workspace_id, m.user_id) AND u.deleted_at IS NULL ORDER BY u.email`,
    [w.id],
  );
  if (!duenos.length) return;
  const c = alertTextsFor(w.locale).email;
  const llenar = (p: Parameters<typeof fillTemplate>[0], v: Record<string, string>) =>
    fillTemplate(p, v, { n: aEnviar.length }, w.locale);
  const n = new Intl.NumberFormat(w.locale).format(aEnviar.length);
  const subject = llenar(urgente ? c.urgentSubject : c.subject, { n, workspace: w.name });
  const base = deps.appUrl ? deps.appUrl.replace(/\/+$/, '') : null;
  const text = [
    llenar(urgente ? c.urgentIntro : c.intro, { workspace: w.name }),
    '',
    ...aEnviar.flatMap((p) => [
      `· ${p.title_es}`,
      ...(p.body_es ? [`  ${p.body_es}`] : []),
      ...(p.action_url && base ? [`  ${llenar(c.link, { url: `${base}${p.action_url}` })}`] : []),
      '',
    ]),
    ...(base ? [] : [c.whereToSee, '']),
    urgente ? c.urgentOutro : c.outro,
  ].join('\n');
  try {
    await deps.mailer.send({ recipients: duenos.map((d) => d.email), subject, text });
  } catch (err) {
    r.emailFailed++;
    throw err;
  }
  await db.query('UPDATE notification SET emailed_at = $2 WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL', [
    aEnviar.map((p) => p.id),
    now.toISOString(),
  ]);
  if (urgente) r.urgentSent++;
  else r.emailsSent++;
}

export async function runAlertas(
  db: JobDatabase,
  now: Date,
  deps: AlertasDeps,
  onError?: (workspaceId: string, err: unknown) => void,
): Promise<AlertasResult> {
  const hora = Math.max(0, Math.min(23, Math.trunc(deps.horaLocal ?? ALERTAS_HORA_LOCAL)));
  const leer = deps.readSignals ?? readSignalsFromDb;
  const r: AlertasResult = {
    workspaces: 0, created: {}, emailsSent: 0, emailSkipped: 0, emailSkippedReason: null, emailFailed: 0, emailDeferred: 0,
    urgentSent: 0,
  };
  for (const w of await espacios(db, now, hora)) {
    r.workspaces++;
    try {
      const creadas = await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ALERTAS_JOB_ID}/${w.id}`]);
        return avisar(tx, w, evaluateOutreachAlerts(await leer(tx, w.id, now)), now);
      });
      for (const k of creadas) r.created[k] = (r.created[k] ?? 0) + 1;
      // Leer lo pendiente, enviarlo y marcarlo, bajo el mismo candado y en
      // UNA transacción: dos corridas que se solapen (un reintento a mano,
      // la cola sin 'stately') no leen los mismos pendientes, y la segunda
      // ve el emailed_at de la primera. Si el correo falla, la transacción
      // se deshace y nada queda marcado. El candado espera al SMTP, que es
      // un correo por workspace: segundos, no minutos.
      await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ALERTAS_JOB_ID}/${w.id}/correo`]);
        await enviarResumen(tx, w, now, deps, r);
      });
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
      // En producción, sin MAIL_FROM el resumen no sale: firmado por un
      // dominio .invalid rebota o va a spam. Sin APP_URL sí sale, sin
      // enlaces y diciendo dónde verlo: una cuenta caída tiene que llegar
      // aunque el enlace no pueda ir (y nunca a localhost).
      const sinRemitente = ctx.env['NODE_ENV'] === 'production' && !ctx.env['MAIL_FROM']?.trim();
      const mailer = sinRemitente ? null : (deps.mailerFromEnv ?? smtpMailerFromEnv)(ctx.env);
      const falta = sinRemitente ? 'MAIL_FROM' : mailer ? null : 'SMTP_URL';
      if (falta === 'MAIL_FROM') {
        ctx.logger.warn('alertas de outreach: MAIL_FROM sin configurar en producción; el resumen no sale', {});
      }
      const appUrl = ctx.env['APP_URL']?.trim() || null;
      if (!appUrl) ctx.logger.warn('alertas de outreach: sin APP_URL, el resumen sale sin enlaces', {});
      let fallos = 0;
      const r = await runAlertas(ctx.db, ctx.now(), { ...deps, mailer, mailerMissing: falta, appUrl }, (ws, err) => {
        fallos++;
        ctx.logger.warn('alertas de outreach: falló un workspace', { workspaceId: ws, error: err instanceof Error ? err.message : String(err) });
      });
      if (r.emailSkipped) {
        ctx.logger.info(`alertas de outreach: sin ${r.emailSkippedReason ?? 'SMTP_URL'}, el resumen no salió`, {
          workspaces: r.emailSkipped,
        });
      }
      const creadas = Object.values(r.created).reduce((a, b) => a + (b ?? 0), 0);
      return { processed: creadas, failed: fallos, metadata: { ...r } };
    },
    { retryOnItemFailure: false },
  );
}

export const alertasJob = createAlertasJob();
