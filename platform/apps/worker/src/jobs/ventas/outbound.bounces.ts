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
 * cliente de Gmail escrito aquí: el conector de Gmail es de VEN-9
 * (packages/connectors, rama rasheed/VEN-9-canales, sin integrar). El
 * adaptador ya está (gmail-rebotes.ts: GmailApi.searchBounces +
 * getMessage → BounceMailbox) y probado contra un Gmail falso con la
 * forma del FakeGmail de VEN-9. Lo que falta es de la integración:
 * construir el GmailApi de cada cuenta con su token y registrar
 * createBouncesJob((cuenta) => gmailBounceMailbox(api)). Hasta entonces el
 * job registrado usa gmailNoConfigurado: cada cuenta cuenta como «canal
 * no configurado», y el job lo dice en el registro. Las pruebas usan un
 * buzón con avisos grabados (test/fixtures/rebotes).
 *
 * Corre como mc_worker (BYPASSRLS): cada consulta filtra por el
 * workspace de la cuenta que se está leyendo, y nada se escribe en otro.
 */
import { detectBounce, type BounceDetection, type InboundMail } from '@mc/core/outreach/deliverability';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';

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
}

/** El buzón de una cuenta, o null si el canal no está configurado (sin conector o sin llaves). */
export type MailboxFor = (account: MailboxAccount) => BounceMailbox | null;

/** Hasta que VEN-9 entregue el conector de Gmail: ninguna cuenta tiene buzón legible. */
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
    // ya le corrigió el correo, el rebote es de la dirección vieja.
    const marca = await tx.query(
      `UPDATE contact
          SET email_invalid = true, email_invalid_at = $2, email_invalid_reason = left($3, 300), bounced = true
        WHERE id = $1 AND NOT email_invalid AND ($4::citext IS NULL OR email = $4::citext)
        RETURNING id`,
      [contactId, now.toISOString(), d.reason || 'Rebote', address],
    );
    const { rows: invalida } = await tx.query<{ email_invalid: boolean }>(
      'SELECT email_invalid FROM contact WHERE id = $1',
      [contactId],
    );
    if (!invalida[0]?.email_invalid) return { inserted: true, invalidated: false, canceled: 0 };
    // Lo que 'processing' tiene es del despachador (0037 §4.1): no se toca.
    const cancel = await tx.query(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'email_invalid'
        WHERE contact_id = $1 AND channel = 'email' AND status IN ('draft', 'scheduled', 'held')
        RETURNING id`,
      [contactId],
    );
    return { inserted: true, invalidated: marca.rows.length > 0, canceled: cancel.rows.length };
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
  const { rows: cuentas } = await db.query<{ id: string; workspace_id: string; provider_account_id: string | null }>(
    `SELECT id, workspace_id, provider_account_id FROM outreach_channel_account
      WHERE channel = 'email' AND status = 'connected' ORDER BY workspace_id, id`,
  );
  for (const c of cuentas) {
    if (opts.signal?.aborted) break;
    r.accounts++;
    const account: MailboxAccount = { id: c.id, workspaceId: c.workspace_id, providerAccountId: c.provider_account_id };
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

/** El job con el buzón que se le dé; el registrado usa gmailNoConfigurado hasta que exista el conector. */
export function createBouncesJob(mailboxFor: MailboxFor) {
  return defineJob(BOUNCES_JOB_ID, async (_payload, ctx) => {
    const r = await runBounces(ctx.db, ctx.now(), mailboxFor, {
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

export const bouncesJob = createBouncesJob(gmailNoConfigurado);
