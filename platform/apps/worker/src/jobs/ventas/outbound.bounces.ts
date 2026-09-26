/**
 * outbound.bounces · los rebotes del correo saliente (VEN-15).
 *
 * Gmail no avisa de un rebote por API: al buzón del creador llega un
 * correo de mailer-daemon. Cada media hora, por cada Gmail conectado:
 *   1. lee los avisos DESDE EL CURSOR de la cuenta
 *      (outreach_channel_account.bounces_read_at, 0038 §6), del más
 *      viejo al más nuevo, como mucho BOUNCES_PER_RUN por pasada, y
 *      avanza el cursor solo hasta el último aviso que leyó. Si leyó
 *      todo lo que había, el cursor queda en «ahora» menos una hora de
 *      solape (lo que Gmail indexa tarde). Una ráfaga de avisos no deja
 *      atrás a los más viejos, y una caída larga tampoco: la próxima
 *      pasada sigue donde quedó;
 *   2. los reconoce y clasifica con detectBounce (@mc/core): duro,
 *      blando o bloqueo;
 *   3. lo anota en outbound_bounce, con el toque que rebotó y su ficha;
 *   4. si es DURO y está VERIFICADO —el aviso trae el Message-ID de un
 *      correo que ESTE workspace envió ('sent', antes del aviso)—:
 *        · marca contact.email_invalid con el motivo, solo si la ficha es
 *          PROPIA de este workspace y sigue teniendo esa dirección;
 *        · cancela los correos pendientes (draft, scheduled, held) de ESTE
 *          workspace a esa dirección: los que ya la llevan en
 *          recipient_address y los que todavía no la tienen pero van a
 *          una ficha con ese correo (la misma regla que el disparador de
 *          0038 §2);
 *        · pausa los enrolamientos activos de esa ficha cuya secuencia
 *          es solo de correo (context.paused_reason = 'email_invalid'):
 *          ya no tienen por dónde seguir;
 *        · y el rebote verificado frena, en este workspace, los correos
 *          nuevos a esa dirección (0038 §2), también a una ficha
 *          compartida. Un correo que estaba en 'processing' cuando llegó
 *          el aviso y que el despachador devuelve a la cola, la base lo
 *          cancela en el sitio (0038 §2);
 *   5. al final de cada pasada, un barrido idempotente de todos los
 *      workspaces (sweepInvalidEmail): cancela lo que haya quedado en
 *      draft, scheduled o held a una dirección que ya rebotó —un borrador
 *      creado después del rebote, por ejemplo— y pausa los enrolamientos
 *      que sigan activos.
 *      Los de LinkedIn e Instagram siguen: un rebote dice que la
 *      dirección no existe, no que la persona pidió no ser contactada, y
 *      por eso tampoco va a contact_suppression.
 *
 * Nada de lo que llega a un buzón tiene efectos en otro workspace. Una
 * ficha compartida (contacto global, owner_workspace_id NULL) no se marca:
 * un aviso falso en el Gmail de un creador —de él mismo, o de un tercero
 * que le escriba— no le cierra el correo a los demás creadores. Y un aviso
 * que no se casa con un correo enviado queda anotado y nada más.
 *
 * El buzón se lee A TRAVÉS de una interfaz (BounceMailbox), no de un
 * cliente de Gmail escrito aquí. El job registrado lee el Gmail de
 * verdad (integración de la fase 4): el mismo GmailChannel del
 * despachador (buildChannels, con el token de cada cuenta del almacén y
 * las llaves de Google de la plataforma) le da a cada cuenta su buzón
 * (bounceMailboxFor), y gmail-rebotes.ts lo traduce (GmailApi.searchBounces
 * + getMessage → BounceMailbox). Sin GOOGLE_OUTREACH_CLIENT_ID/SECRET, o con el
 * canal falso, las cuentas cuentan como «canal no configurado» y el job lo
 * dice en el registro. Las pruebas usan un buzón con avisos grabados
 * (test/fixtures/rebotes) y el FakeGmail de VEN-9.
 *
 * Corre como mc_worker (BYPASSRLS): cada consulta filtra por el
 * workspace de la cuenta que se está leyendo, y nada se escribe en otro.
 */
import { detectBounce, type BounceDetection, type InboundMail } from '@mc/core/outreach/deliverability';
import { PostgresOutreachCallLog } from '@mc/connectors';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext } from '../../runner/registry.ts';
import { buildChannels, jobScope } from './canales/index.ts';

export const BOUNCES_JOB_ID = 'outbound.bounces';

/** Cuánto hacia atrás se lee la primera vez (sin cursor). */
export const BOUNCES_FIRST_LOOKBACK_H = 72;
/** Con todo leído, la pasada siguiente vuelve a mirar esta última hora: Gmail indexa algún aviso tarde. */
export const BOUNCES_OVERLAP_H = 1;
/** Un cursor más viejo que esto (una cuenta caída un mes) se lee desde aquí. */
export const BOUNCES_MAX_LOOKBACK_D = 30;
/** Avisos que se leen, como mucho, por cuenta y pasada. Lo demás, en la siguiente. */
export const BOUNCES_PER_RUN = 300;

/** Un aviso del buzón, como lo entrega el conector. */
export interface BounceMessage extends InboundMail {
  /** El id del mensaje en el buzón (Gmail: message.id). La llave de idempotencia. */
  id: string;
  receivedAt: Date;
}

/** Lo que devuelve una lectura del buzón. */
export interface BounceBatch {
  /** Del más viejo al más nuevo. */
  messages: BounceMessage[];
  /** Se leyó todo lo que había desde `since`. Si no, la próxima pasada sigue desde el último. */
  complete: boolean;
  /**
   * El buzón no sabe paginar y la lista vino llena: pudo haber avisos más
   * viejos que no llegaron. Se dice en el registro.
   */
  truncated?: boolean;
}

/** Lo único que este job necesita de un buzón. */
export interface BounceMailbox {
  /**
   * Los mensajes recibidos desde `since` que pueden ser avisos de rebote
   * (el conector puede filtrar por remitente), del más viejo al más
   * nuevo, como mucho `max`.
   */
  listBounceCandidates(opts: {
    since: Date;
    max: number;
    signal?: AbortSignal;
    /**
     * Cuáles de estos ids ya están anotados (outbound_bounce del
     * workspace): el buzón no los vuelve a pedir enteros (Gmail:
     * messages.get) ni cuentan para `max`. El solape del cursor relee la
     * última hora; así no cuesta una llamada por aviso ya guardado.
     */
    known?: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  }): Promise<BounceBatch>;
}

export interface MailboxAccount {
  id: string;
  workspaceId: string;
  providerAccountId: string | null;
  /**
   * La referencia del token de la cuenta en el vault
   * (outreach_channel_account.secret_ref, 'enc:…'): con ella la
   * integración de VEN-9 saca el token y arma el GmailClient. El token
   * nunca pasa por aquí ni por la base en claro.
   */
  secretRef: string | null;
}

/**
 * El buzón de una cuenta, o null si el canal no está configurado (sin
 * conector, sin llaves de Google o sin token). Puede ser asíncrono: el
 * token sale del vault. Si lanza, la cuenta cuenta como fallida y las
 * demás siguen.
 */
export type MailboxFor = (account: MailboxAccount) => BounceMailbox | null | Promise<BounceMailbox | null>;

/** Ninguna cuenta tiene buzón legible (sin llaves de Google, o con el canal falso). */
export const gmailNoConfigurado: MailboxFor = () => null;

export interface BouncesResult {
  accounts: number;
  notConfigured: number;
  read: number;
  bounces: number;
  hard: number;
  /** Rebotes duros casados con un correo enviado por ese workspace: los que tienen efectos. */
  verified: number;
  contactsInvalidated: number;
  touchesCanceled: number;
  /** Enrolamientos de secuencias solo de correo pausados por el correo inválido. */
  enrollmentsPaused: number;
  /** Cuentas cuyo buzón falló al leerse (red, token vencido). */
  failed: number;
  /** Cuentas con más avisos de los que caben en una pasada: siguen en la próxima. */
  pending: number;
  /** Cuentas cuyo buzón no pagina y pudo dejar avisos viejos fuera. */
  truncated: number;
}

type TouchRow = {
  id: string;
  contact_id: string | null;
  recipient_address: string | null;
};

/**
 * El correo que rebotó: el toque 'sent' de ESTE workspace cuyo
 * Message-ID trae el aviso, enviado antes del aviso. outbound_touch no
 * guarda la cuenta que lo envió (0037), así que la prueba es esa: solo
 * quien recibió el correo, o quien lo envió, conoce su Message-ID, y un
 * aviso no puede llegar antes que el correo. Sin Message-ID no se adivina
 * por la dirección: el aviso queda anotado sin efectos.
 */
async function sentTouch(tx: Queryable, workspaceId: string, d: BounceDetection, receivedAt: Date): Promise<TouchRow | null> {
  if (!d.originalMessageId) return null;
  const { rows } = await tx.query<TouchRow>(
    `SELECT id, contact_id, recipient_address FROM outbound_touch
      WHERE workspace_id = $1 AND channel = 'email' AND status = 'sent'
        AND message_id_rfc IN ($2, '<' || $2 || '>')
        AND (sent_at IS NULL OR sent_at <= $3)
      ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
    [workspaceId, d.originalMessageId, receivedAt.toISOString()],
  );
  return rows[0] ?? null;
}

/** La ficha PROPIA del workspace con esa dirección, para la bitácora de un aviso sin toque. */
async function contactByAddress(tx: Queryable, workspaceId: string, address: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM contact WHERE owner_workspace_id = $1 AND email = $2::citext ORDER BY created_at, id LIMIT 1',
    [workspaceId, address],
  );
  return rows[0]?.id ?? null;
}

interface Registro {
  inserted: boolean;
  verified: boolean;
  invalidated: boolean;
  canceled: number;
  paused: number;
}

/** Anota un aviso ya reconocido y, si es duro y verificado, aplica sus efectos en ESTE workspace. Una transacción. */
async function registrar(
  db: JobDatabase,
  account: MailboxAccount,
  msg: BounceMessage,
  d: BounceDetection,
  now: Date,
): Promise<Registro> {
  return db.transaction(async (tx) => {
    const ws = account.workspaceId;
    const touch = await sentTouch(tx, ws, d, msg.receivedAt);
    // Con el toque, la dirección es la suya: es a la que salió el correo, y
    // la del aviso puede venir mal leída de la prosa.
    const address = touch?.recipient_address ?? d.recipient ?? null;
    const verified = touch !== null && address !== null;
    const contactId = touch?.contact_id ?? (address ? await contactByAddress(tx, ws, address) : null);
    const ins = await tx.query(
      `INSERT INTO outbound_bounce (workspace_id, channel_account_id, provider_message_id, touch_id, contact_id,
                                    recipient_address, verified, kind, status_code, smtp_code, reason, received_at,
                                    detected_at)
       VALUES ($1, $2, $3, $4, $5, $6::citext, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (workspace_id, provider_message_id) DO NOTHING
       RETURNING id`,
      [
        ws, account.id, msg.id.slice(0, 200), touch?.id ?? null, contactId, address, verified, d.kind,
        d.statusCode, d.smtpCode, d.reason || 'Rebote', msg.receivedAt.toISOString(), now.toISOString(),
      ],
    );
    const nada = { inserted: ins.rows.length > 0, verified, invalidated: false, canceled: 0, paused: 0 };
    if (!ins.rows.length || d.kind !== 'hard' || !verified) return nada;

    // La ficha, solo si es de este workspace y SIGUE teniendo la dirección
    // que rebotó (si alguien ya le corrigió el correo, el rebote es de la
    // vieja). Una ficha compartida no se toca: la frena el rebote
    // verificado de este workspace (0038 §2).
    let invalidated = false;
    if (contactId) {
      const marca = await tx.query(
        `UPDATE contact
            SET email_invalid = true, email_invalid_at = $3, email_invalid_reason = left($4, 300), bounced = true
          WHERE id = $1 AND owner_workspace_id = $2 AND NOT email_invalid AND email = $5::citext
          RETURNING id`,
        [contactId, ws, now.toISOString(), d.reason || 'Rebote', address],
      );
      invalidated = marca.rows.length > 0;
    }
    // Los correos pendientes de ESTE workspace a esa dirección y los
    // enrolamientos que ya no tienen por dónde seguir, en la misma
    // transacción. Lo que 'processing' tiene es del despachador (0037
    // §4.1): si lo devuelve a la cola, la base lo cancela (0038 §2).
    const barrido = await sweepInvalidEmail(tx, ws, now);
    return { inserted: true, verified, invalidated, canceled: barrido.canceled, paused: barrido.paused };
  });
}

export interface SweepResult {
  canceled: number;
  paused: number;
}

/**
 * El barrido del correo inválido: idempotente, se puede correr cuantas
 * veces se quiera. En `workspaceId` (o en todos, con null):
 *   · cancela los correos en draft, scheduled o held a una dirección que
 *     rebotó: la de una ficha con email_invalid, o una con un rebote duro
 *     verificado de ESE workspace (outbound_bounce). La misma regla que el
 *     disparador de 0038 §2: la dirección que cuenta es la del envío si ya
 *     la tiene, y si no la de la ficha.
 *   · pausa los enrolamientos activos de esa ficha en ESE workspace cuya
 *     secuencia es solo de correo (canal 'email' y ningún paso de otro
 *     canal), con context.paused_reason = 'email_invalid': sin esto el
 *     enrolamiento seguía «activo» y el planificador de VEN-10 chocaba con
 *     la regla de 0038 §2 en cada vuelta. Una secuencia con LinkedIn o
 *     Instagram sigue por ahí; sus pasos de correo los salta el
 *     planificador (docs/ventas-outreach.md §5.2).
 * Hace falta además del disparador porque el disparador solo mira la
 * entrada en la cola: un borrador creado después del rebote, o uno que ya
 * estaba en draft o held cuando la ficha se marcó, no lo cancela nadie
 * más. Cada pasada del job lo corre al final para todos los workspaces,
 * pero solo sobre los candidatos (fichas con email_invalid y direcciones
 * con un rebote duro verificado, no workspaces enteros) y por el índice parcial de los correos
 * pendientes (0038 §2): sin rebotes, la pasada no recorre outbound_touch.
 */
export async function sweepInvalidEmail(q: Queryable, workspaceId: string | null, now: Date): Promise<SweepResult> {
  const cancel = await q.query(
    `UPDATE outbound_touch t SET status = 'canceled', blocked_reason = 'email_invalid'
      WHERE ($1::uuid IS NULL OR t.workspace_id = $1::uuid)
        AND t.channel = 'email' AND t.status IN ('draft', 'scheduled', 'held')
        -- Solo los candidatos, por DIRECCIÓN y no por workspace: fichas
        -- marcadas, fichas cuya dirección tiene un rebote duro verificado y
        -- correos dirigidos a una dirección así. Un workspace con un solo
        -- rebote ya no vuelve candidatos todos sus correos pendientes en
        -- cada pasada; la comprobación exacta (qué workspace, qué
        -- dirección) la hacen los EXISTS de abajo.
        AND (t.contact_id IN (SELECT c.id FROM contact c WHERE c.email_invalid)
             OR t.contact_id IN (SELECT c.id FROM outbound_bounce b JOIN contact c ON c.email = b.recipient_address
                                  WHERE b.kind = 'hard' AND b.verified)
             OR (t.workspace_id, t.recipient_address) IN (SELECT b.workspace_id, b.recipient_address FROM outbound_bounce b
                                                           WHERE b.kind = 'hard' AND b.verified))
        AND (EXISTS (SELECT 1 FROM contact c
                      WHERE c.id = t.contact_id AND c.email_invalid
                        AND (t.recipient_address IS NULL OR t.recipient_address = c.email))
             OR EXISTS (SELECT 1 FROM outbound_bounce b
                         WHERE b.workspace_id = t.workspace_id AND b.kind = 'hard' AND b.verified
                           AND b.recipient_address = coalesce(t.recipient_address,
                                                              (SELECT c.email FROM contact c WHERE c.id = t.contact_id))))
      RETURNING t.id`,
    [workspaceId],
  );
  // Quien pidió la baja no se pausa: su enrolamiento es de la regla de la
  // baja (0037 §3.3, 0038 §8), y pausarlo la haría saltar.
  const pause = await q.query(
    `UPDATE outbound_enrollment e
        SET status = 'paused',
            context = e.context || jsonb_build_object('paused_reason', 'email_invalid', 'paused_at', $2::text)
       FROM contact c, outbound_sequence s
      WHERE ($1::uuid IS NULL OR e.workspace_id = $1::uuid)
        AND e.status = 'active' AND c.id = e.contact_id AND s.id = e.sequence_id
        AND (e.contact_id IN (SELECT x.id FROM contact x WHERE x.email_invalid)
             OR e.contact_id IN (SELECT x.id FROM outbound_bounce b JOIN contact x ON x.email = b.recipient_address
                                  WHERE b.kind = 'hard' AND b.verified))
        AND c.email IS NOT NULL
        AND (c.email_invalid
             OR EXISTS (SELECT 1 FROM outbound_bounce b
                         WHERE b.workspace_id = e.workspace_id AND b.kind = 'hard' AND b.verified
                           AND b.recipient_address = c.email))
        AND s.channel = 'email'
        AND NOT EXISTS (SELECT 1 FROM outbound_step st WHERE st.sequence_id = s.id AND st.channel <> 'email')
        AND NOT c.opted_out AND NOT address_is_suppressed(c.email)
        AND NOT EXISTS (SELECT 1 FROM outbound_workspace_optout o WHERE o.workspace_id = e.workspace_id AND o.email = c.email)
      RETURNING e.id`,
    [workspaceId, now.toISOString()],
  );
  return { canceled: cancel.rows.length, paused: pause.rows.length };
}

/** Desde cuándo leer una cuenta: su cursor, o las últimas 72 h la primera vez. Nunca más de un mes. */
function desde(cursor: Date | null, now: Date): Date {
  const primera = new Date(now.getTime() - BOUNCES_FIRST_LOOKBACK_H * 3_600_000);
  if (!cursor) return primera;
  const piso = new Date(now.getTime() - BOUNCES_MAX_LOOKBACK_D * 86_400_000);
  return cursor > piso ? cursor : piso;
}

/**
 * El cursor después de una lectura. Si se leyó todo, «ahora» menos el
 * solape (sin volver atrás del que había); si no, el último aviso leído:
 * la pasada siguiente sigue desde ahí.
 */
export function nextBouncesCursor(since: Date, batch: BounceBatch, now: Date): Date {
  if (batch.complete) {
    const conSolape = new Date(now.getTime() - BOUNCES_OVERLAP_H * 3_600_000);
    return conSolape > since ? conSolape : since;
  }
  const ultimo = batch.messages.at(-1)?.receivedAt;
  return ultimo && ultimo > since ? ultimo : since;
}

export interface BouncesOptions {
  signal?: AbortSignal;
  /** Para el registro: una cuenta que falló no tumba a las demás. */
  onAccountError?: (account: MailboxAccount, err: unknown) => void;
  /** Para el registro: un buzón que no pagina pudo dejar avisos fuera. */
  onTruncated?: (account: MailboxAccount) => void;
  /** Avisos por cuenta y pasada (BOUNCES_PER_RUN). */
  perRun?: number;
}

export async function runBounces(db: JobDatabase, now: Date, mailboxFor: MailboxFor, opts: BouncesOptions = {}): Promise<BouncesResult> {
  const r: BouncesResult = {
    accounts: 0, notConfigured: 0, read: 0, bounces: 0, hard: 0, verified: 0, contactsInvalidated: 0, touchesCanceled: 0,
    enrollmentsPaused: 0, failed: 0, pending: 0, truncated: 0,
  };
  const max = Math.max(1, Math.trunc(opts.perRun ?? BOUNCES_PER_RUN));
  const { rows: cuentas } = await db.query<{
    id: string; workspace_id: string; provider_account_id: string | null; secret_ref: string | null;
    bounces_read_at: Date | string | null;
  }>(
    `SELECT id, workspace_id, provider_account_id, secret_ref, bounces_read_at FROM outreach_channel_account
      WHERE channel = 'email' AND status = 'connected' ORDER BY workspace_id, id`,
  );
  for (const c of cuentas) {
    if (opts.signal?.aborted) break;
    r.accounts++;
    const account: MailboxAccount = {
      id: c.id, workspaceId: c.workspace_id, providerAccountId: c.provider_account_id, secretRef: c.secret_ref,
    };
    let mailbox: BounceMailbox | null;
    try {
      mailbox = await mailboxFor(account);
    } catch (err) {
      // Un token que no descifra, el vault caído: esta cuenta falla, las demás siguen.
      r.failed++;
      opts.onAccountError?.(account, err);
      continue;
    }
    if (!mailbox) {
      r.notConfigured++;
      continue;
    }
    try {
      const since = desde(c.bounces_read_at ? new Date(c.bounces_read_at) : null, now);
      const known = async (ids: readonly string[]): Promise<ReadonlySet<string>> => {
        if (!ids.length) return new Set();
        const { rows } = await db.query<{ id: string }>(
          `SELECT provider_message_id AS id FROM outbound_bounce
            WHERE workspace_id = $1 AND provider_message_id = ANY($2::text[])`,
          [account.workspaceId, ids.map((id) => id.slice(0, 200))],
        );
        return new Set(rows.map((x) => x.id));
      };
      const batch = await mailbox.listBounceCandidates({ since, max, signal: opts.signal, known });
      const leidos: BounceMessage[] = [];
      for (const msg of batch.messages) {
        if (opts.signal?.aborted) break;
        r.read++;
        leidos.push(msg);
        const d = detectBounce(msg);
        if (!d) continue;
        const reg = await registrar(db, account, msg, d, now);
        if (!reg.inserted) continue;
        r.bounces++;
        if (d.kind === 'hard') r.hard++;
        if (d.kind === 'hard' && reg.verified) r.verified++;
        if (reg.invalidated) r.contactsInvalidated++;
        r.touchesCanceled += reg.canceled;
        r.enrollmentsPaused += reg.paused;
      }
      // Lo que se cortó a medias (una señal de parar) cuenta como no leído.
      const leido: BounceBatch = {
        messages: leidos,
        complete: batch.complete && leidos.length === batch.messages.length,
      };
      if (!leido.complete) r.pending++;
      if (batch.truncated) {
        r.truncated++;
        opts.onTruncated?.(account);
      }
      await db.query(
        'UPDATE outreach_channel_account SET bounces_read_at = $3 WHERE id = $1 AND workspace_id = $2',
        [account.id, account.workspaceId, nextBouncesCursor(since, leido, now).toISOString()],
      );
    } catch (err) {
      r.failed++;
      opts.onAccountError?.(account, err);
    }
  }
  // El barrido de todos los workspaces, también de los que no se leyeron
  // en esta pasada: lo que se creó en draft o held después de un rebote,
  // o un enrolamiento que quedó activo, se cierra aquí.
  const barrido = await db.transaction((tx) => sweepInvalidEmail(tx, null, now));
  r.touchesCanceled += barrido.canceled;
  r.enrollmentsPaused += barrido.paused;
  return r;
}

/** El job con el buzón que se arma con el contexto de cada corrida. */
export function createBouncesJobFrom(build: (ctx: JobContext) => MailboxFor) {
  return defineJob(BOUNCES_JOB_ID, async (_payload, ctx) => {
    const r = await runBounces(ctx.db, ctx.now(), build(ctx), {
      signal: ctx.signal,
      onAccountError: (a, err) =>
        ctx.logger.warn('no se pudo leer el buzón de rebotes', { accountId: a.id, error: err instanceof Error ? err.message : String(err) }),
      onTruncated: (a) =>
        ctx.logger.warn('rebotes: el buzón no pagina y la lista vino llena; pudieron quedar avisos viejos sin leer', {
          accountId: a.id,
        }),
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
 * Los buzones de verdad: el GmailChannel de buildChannels, el
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

/** De dónde saca el job registrado sus buzones: el Gmail de verdad (la prueba de la integración lo fija). */
export const bouncesMailboxSource: (ctx: JobContext) => MailboxFor = gmailMailboxes;

export const bouncesJob = createBouncesJobFrom(bouncesMailboxSource);
