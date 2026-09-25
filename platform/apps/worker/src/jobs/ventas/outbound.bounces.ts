/**
 * outbound.bounces · los rebotes del correo saliente (VEN-15).
 *
 * Gmail no avisa de un rebote por API: al buzón del creador llega un
 * correo de mailer-daemon. Cada media hora, por cada Gmail conectado:
 *   1. lee los avisos desde la última lectura (con una hora de solape;
 *      la bitácora es única por aviso, así que leer dos veces no cuenta
 *      dos rebotes);
 *   2. los reconoce y clasifica con detectBounce (@mc/core): duro,
 *      blando o bloqueo;
 *   3. lo anota en outbound_bounce, con el toque que rebotó (por su
 *      Message-ID, o el último enviado a esa dirección) y su ficha;
 *   4. si es DURO: marca contact.email_invalid con el motivo y cancela
 *      los correos pendientes de esa ficha (draft, scheduled, held). Los
 *      de LinkedIn e Instagram siguen: un rebote dice que la dirección
 *      no existe, no que la persona pidió no ser contactada, y por eso
 *      tampoco va a contact_suppression (0038).
 *
 * El buzón se lee A TRAVÉS de una interfaz (BounceMailbox), no de un
 * cliente de Gmail escrito aquí. (VEN-10 r4) El job registrado lee el
 * Gmail de verdad: el mismo GmailChannel del despachador (buildChannels,
 * con el token de cada cuenta del almacén y las llaves de Google de la
 * plataforma) le da a cada cuenta su buzón (bounceMailboxFor), y
 * gmail-rebotes.ts lo traduce (GmailApi.searchBounces + getMessage →
 * BounceMailbox). Sin GOOGLE_CLIENT_ID/SECRET, o con el canal falso, las
 * cuentas cuentan como «canal no configurado» y el job lo dice en el
 * registro. Las pruebas usan un buzón con avisos grabados
 * (test/fixtures/rebotes) y el FakeGmail de VEN-9.
 *
 * Lo que marca un rebote duro (la ficha, sus correos, sus enrolamientos)
 * lo hace markContactEmailInvalid de @mc/db, la misma función que usa el
 * despachador cuando el envío mismo rebota: un rebote deja lo mismo en la
 * base llegue por donde llegue.
 *
 * Corre como mc_worker (BYPASSRLS): cada consulta filtra por el
 * workspace de la cuenta que se está leyendo, y nada se escribe en otro.
 */
import { detectBounce, type BounceDetection, type InboundMail } from '@mc/core/outreach/deliverability';
import { finishBouncedEnrollments, markContactEmailInvalid } from '@mc/db/queries/outreach';
import { workerSqlFrom } from '@mc/db/worker';
import { PostgresOutreachCallLog } from '@mc/connectors';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext } from '../../runner/registry.ts';
import { buildChannels, jobScope } from './canales/index.ts';

export const BOUNCES_JOB_ID = 'outbound.bounces';

/** Cuánto hacia atrás se lee la primera vez, y el solape de las siguientes. */
export const BOUNCES_FIRST_LOOKBACK_H = 72;
export const BOUNCES_OVERLAP_H = 1;

/** Un aviso del buzón, como lo entrega el conector. */
export interface BounceMessage extends InboundMail {
  /** El id del mensaje en el buzón (Gmail: message.id). La llave de idempotencia. */
  id: string;
  receivedAt: Date;
}

/** Lo único que este job necesita de un buzón. */
export interface BounceMailbox {
  /** Los mensajes recibidos desde `since` que pueden ser avisos de rebote (el conector puede filtrar por remitente). */
  listBounceCandidates(opts: { since: Date; signal?: AbortSignal }): Promise<BounceMessage[]>;
}

export interface MailboxAccount {
  id: string;
  workspaceId: string;
  providerAccountId: string | null;
  /** La referencia del token en el almacén (nunca el token). */
  secretRef: string | null;
}

/** El buzón de una cuenta, o null si el canal no está configurado (sin conector o sin llaves). */
export type MailboxFor = (account: MailboxAccount) => BounceMailbox | null;

/** Ninguna cuenta tiene buzón legible (sin llaves de Google, o con el canal falso). */
export const gmailNoConfigurado: MailboxFor = () => null;

export interface BouncesResult {
  accounts: number;
  notConfigured: number;
  read: number;
  bounces: number;
  hard: number;
  contactsInvalidated: number;
  touchesCanceled: number;
  /** Cuentas cuyo buzón falló al leerse (red, token vencido). */
  failed: number;
}

type TouchRow = {
  id: string;
  contact_id: string | null;
  recipient_address: string | null;
};

async function touchOf(tx: Queryable, workspaceId: string, d: BounceDetection): Promise<TouchRow | null> {
  if (d.originalMessageId) {
    const { rows } = await tx.query<TouchRow>(
      `SELECT id, contact_id, recipient_address FROM outbound_touch
        WHERE workspace_id = $1 AND channel = 'email' AND message_id_rfc IN ($2, '<' || $2 || '>')
        ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [workspaceId, d.originalMessageId],
    );
    if (rows[0]) return rows[0];
  }
  if (d.recipient) {
    const { rows } = await tx.query<TouchRow>(
      `SELECT id, contact_id, recipient_address FROM outbound_touch
        WHERE workspace_id = $1 AND channel = 'email' AND status = 'sent' AND recipient_address = $2::citext
        ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [workspaceId, d.recipient],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/** La ficha del workspace con esa dirección, si el aviso no trae un toque nuestro. */
async function contactByAddress(tx: Queryable, workspaceId: string, address: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM contact WHERE owner_workspace_id = $1 AND email = $2::citext LIMIT 1',
    [workspaceId, address],
  );
  return rows[0]?.id ?? null;
}

interface Registro {
  inserted: boolean;
  invalidated: boolean;
  canceled: number;
}

/** Anota un aviso ya reconocido, y si es duro marca la ficha y cancela sus correos. Una transacción. */
async function registrar(
  db: JobDatabase,
  account: MailboxAccount,
  msg: BounceMessage,
  d: BounceDetection,
  now: Date,
): Promise<Registro> {
  return db.transaction(async (tx) => {
    const touch = await touchOf(tx, account.workspaceId, d);
    const address = d.recipient ?? touch?.recipient_address ?? null;
    const contactId = touch?.contact_id ?? (address ? await contactByAddress(tx, account.workspaceId, address) : null);
    const ins = await tx.query(
      `INSERT INTO outbound_bounce (workspace_id, channel_account_id, provider_message_id, touch_id, contact_id,
                                    recipient_address, kind, status_code, smtp_code, reason, received_at, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6::citext, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workspace_id, provider_message_id) DO NOTHING
       RETURNING id`,
      [
        account.workspaceId, account.id, msg.id.slice(0, 200), touch?.id ?? null, contactId, address, d.kind,
        d.statusCode, d.smtpCode, d.reason || 'Rebote', msg.receivedAt.toISOString(), now.toISOString(),
      ],
    );
    if (!ins.rows.length) return { inserted: false, invalidated: false, canceled: 0 };
    if (d.kind !== 'hard' || !contactId) return { inserted: true, invalidated: false, canceled: 0 };

    // Solo si la ficha SIGUE teniendo la dirección que rebotó: si alguien
    // ya le corrigió el correo, el rebote es de la dirección vieja. Lo que
    // 'processing' tiene es del despachador (0037 §4.1): no se toca.
    const sql = workerSqlFrom(tx);
    const marked = await markContactEmailInvalid(sql, { contactId, address, reason: d.reason || 'Rebote', now });
    if (!marked.isInvalid) return { inserted: true, invalidated: false, canceled: 0 };
    await finishBouncedEnrollments(sql, marked.canceled.flatMap((c) => (c.enrollmentId ? [c.enrollmentId] : [])), now);
    return { inserted: true, invalidated: marked.invalidated, canceled: marked.canceled.length };
  });
}

/** Desde cuándo leer una cuenta: el último aviso anotado menos el solape, o las últimas 72 h. */
async function desde(db: Queryable, accountId: string, now: Date): Promise<Date> {
  const { rows } = await db.query<{ ultimo: Date | string | null }>(
    'SELECT max(received_at) AS ultimo FROM outbound_bounce WHERE channel_account_id = $1',
    [accountId],
  );
  const ultimo = rows[0]?.ultimo ? new Date(rows[0].ultimo) : null;
  const piso = new Date(now.getTime() - BOUNCES_FIRST_LOOKBACK_H * 3_600_000);
  if (!ultimo) return piso;
  const conSolape = new Date(ultimo.getTime() - BOUNCES_OVERLAP_H * 3_600_000);
  return conSolape > piso ? conSolape : piso;
}

export interface BouncesOptions {
  signal?: AbortSignal;
  /** Para el registro: una cuenta que falló no tumba a las demás. */
  onAccountError?: (account: MailboxAccount, err: unknown) => void;
}

export async function runBounces(db: JobDatabase, now: Date, mailboxFor: MailboxFor, opts: BouncesOptions = {}): Promise<BouncesResult> {
  const r: BouncesResult = {
    accounts: 0, notConfigured: 0, read: 0, bounces: 0, hard: 0, contactsInvalidated: 0, touchesCanceled: 0, failed: 0,
  };
  const { rows: cuentas } = await db.query<{ id: string; workspace_id: string; provider_account_id: string | null; secret_ref: string | null }>(
    `SELECT id, workspace_id, provider_account_id, secret_ref FROM outreach_channel_account
      WHERE channel = 'email' AND status = 'connected' ORDER BY workspace_id, id`,
  );
  for (const c of cuentas) {
    if (opts.signal?.aborted) break;
    r.accounts++;
    const account: MailboxAccount = { id: c.id, workspaceId: c.workspace_id, providerAccountId: c.provider_account_id, secretRef: c.secret_ref };
    const mailbox = mailboxFor(account);
    if (!mailbox) {
      r.notConfigured++;
      continue;
    }
    try {
      const mensajes = await mailbox.listBounceCandidates({ since: await desde(db, account.id, now), signal: opts.signal });
      for (const msg of mensajes) {
        r.read++;
        const d = detectBounce(msg);
        if (!d) continue;
        const reg = await registrar(db, account, msg, d, now);
        if (!reg.inserted) continue;
        r.bounces++;
        if (d.kind === 'hard') r.hard++;
        if (reg.invalidated) r.contactsInvalidated++;
        r.touchesCanceled += reg.canceled;
      }
    } catch (err) {
      r.failed++;
      opts.onAccountError?.(account, err);
    }
  }
  return r;
}

/** El job con el buzón que se arma con el contexto de cada corrida. */
export function createBouncesJobFrom(build: (ctx: JobContext) => MailboxFor) {
  return defineJob(BOUNCES_JOB_ID, async (_payload, ctx) => {
    const r = await runBounces(ctx.db, ctx.now(), build(ctx), {
      signal: ctx.signal,
      onAccountError: (a, err) =>
        ctx.logger.warn('no se pudo leer el buzón de rebotes', { accountId: a.id, error: err instanceof Error ? err.message : String(err) }),
    });
    if (r.notConfigured > 0) {
      ctx.logger.info('rebotes: canal de correo no configurado', { cuentas: r.notConfigured });
    }
    return {
      processed: r.bounces,
      failed: r.failed,
      metadata: { ...r },
    };
  });
}

/** El job con un buzón fijo (las pruebas). */
export function createBouncesJob(mailboxFor: MailboxFor) {
  return createBouncesJobFrom(() => mailboxFor);
}

/**
 * Los buzones de verdad (VEN-10 r4): el GmailChannel de buildChannels, el
 * mismo del despachador, con el almacén de tokens y las llaves de Google
 * del worker, y la bitácora de api_call_log. Sin llaves, o con el canal
 * falso, ninguna cuenta tiene buzón (canal no configurado).
 */
export function gmailMailboxes(ctx: JobContext): MailboxFor {
  return buildChannels({
    env: ctx.env, scope: jobScope(ctx), secrets: ctx.secrets, logger: ctx.logger, callLog: new PostgresOutreachCallLog(ctx.db),
    now: () => ctx.now(),
  }).bounces;
}

export const bouncesJob = createBouncesJobFrom(gmailMailboxes);
