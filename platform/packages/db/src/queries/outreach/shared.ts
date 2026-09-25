/**
 * Outreach · el motor de cadencias (VEN-10): el vocabulario común a
 * enrolar, reclamar, enviar y leer respuestas. Dueño: Rasheed.
 *
 * El motor vive en cuatro archivos (r2), reexportados desde
 * queries/outreach.ts:
 *
 *   enroll.ts    un contacto entra en una secuencia: su enrolamiento y un
 *                toque por paso con su hora (días hábiles, zona, ventana y
 *                dispersión de @mc/core). Solo fichas del workspace.
 *   claim.ts     el reclamo del despachador: ventana, orden de los pasos,
 *                cuenta, topes; devolver a la cola lo no intentado; zombis.
 *   send.ts      la transacción del envío: releer, decidir, registrar.
 *   replies.ts   los hilos abiertos y las respuestas (baja incluida).
 *
 * El reloj lo pone quien llama (`now`): el worker pasa el suyo y las
 * pruebas avanzan uno falso. Lo único que no se puede adelantar son los
 * contadores de 0037, que cuentan el día con now() de la base.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_SEND_WINDOW, shiftFollowingSteps, type SendWindow } from '@mc/core';
import { isUuid, type SqlExecutor, type WorkerSql } from '../../client.ts';
import { OutreachShapeError } from '../outreach.ts';

// ---------------------------------------------------------------------
// Vocabulario del motor
// ---------------------------------------------------------------------

/** Los tipos de paso que el despachador envía solo. El resto es trabajo de una persona (draft). */
export const DISPATCHABLE_STEP_TYPES = ['email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'instagram_dm'] as const;
export type DispatchableStepType = (typeof DISPATCHABLE_STEP_TYPES)[number];

/** Los canales que tienen adaptador (ChannelSender) en el worker. WhatsApp es fase 2. */
export const DISPATCH_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

/** Los proveedores de una cuenta de envío (outreach_channel_account.provider). */
export const SENDER_PROVIDERS = ['gmail_oauth', 'unipile'] as const;
export type SenderProvider = (typeof SENDER_PROVIDERS)[number];

/** Lo que el despachador hace como máximo por corrida (docs/ventas-outreach.md §9). */
export const DISPATCH_BATCH_SIZE = 50;
/** Minutos en processing a partir de los cuales un toque es un zombi. */
export const ZOMBIE_AFTER_MINUTES = 5;
/** Cuánto espera un toque cuya cuenta no está conectada antes de volver a mirar (dentro de la ventana). */
export const ACCOUNT_WAIT_MS = 60 * 60 * 1000;

/**
 * Tope diario de una cuenta que no tiene el suyo (daily_cap NULL): el
 * extremo bajo de §5.1, muy por debajo del techo del canal. La semana es
 * cinco días de ese tope.
 */
export const DEFAULT_ACCOUNT_DAILY_CAP: Record<DispatchChannel, number> = { email: 50, linkedin: 20, instagram_dm: 20 };

/** La acción que cuenta en outbound_counter por cada tipo de paso. */
export function actionTypeFor(stepType: string | null, channel: string): string {
  switch (stepType) {
    case 'email':
    case 'email_reply':
      return 'email';
    case 'linkedin_connect':
      return 'linkedin_invite';
    case 'linkedin_message':
      return 'linkedin_message';
    case 'instagram_dm':
      return 'instagram_dm';
    default:
      return channel === 'email' ? 'email' : channel === 'linkedin' ? 'linkedin_message' : channel;
  }
}

/** El tipo de paso de un toque sin paso (un toque suelto de la web): el mensaje de su canal. */
export function stepTypeForChannel(channel: string): DispatchableStepType | null {
  if (channel === 'email') return 'email';
  if (channel === 'linkedin') return 'linkedin_message';
  if (channel === 'instagram_dm') return 'instagram_dm';
  return null;
}

/** Un error del motor con código estable (lo traduce la pantalla que enrola). */
export class OutreachMotorError extends Error {
  readonly code: 'sequence_not_found' | 'sequence_not_active' | 'sequence_without_steps' | 'invalid_input';
  constructor(code: OutreachMotorError['code'], message: string) {
    super(message);
    this.name = 'OutreachMotorError';
    this.code = code;
  }
}

export function assertIds(fn: string, ids: readonly string[]): void {
  for (const id of ids) if (!isUuid(id)) throw new OutreachMotorError('invalid_input', `${fn}: «${id}» no es un uuid.`);
}

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'HH:MM:SS' de Postgres a la ventana de @mc/core, con la de siempre si no hay política. */
export function windowOf(start: string | null, end: string | null): SendWindow {
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : DEFAULT_SEND_WINDOW;
}

// ---------------------------------------------------------------------
// La forma de las filas (r2): lo que llega de la base se comprueba
// ---------------------------------------------------------------------

/** Un valor de una lista cerrada, o OutreachShapeError con la ruta del campo. */
export function oneOf<const T extends readonly string[]>(fn: string, path: string, value: unknown, list: T): T[number] {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new OutreachShapeError(fn, path, `valor desconocido «${String(value)}» (se esperaba ${list.join(', ')})`);
  }
  return value as T[number];
}

/** Un texto obligatorio. */
export function text(fn: string, path: string, value: unknown): string {
  if (typeof value !== 'string') throw new OutreachShapeError(fn, path, `se esperaba texto, llegó ${typeof value}`);
  return value;
}

/** Un texto o null. */
export function textOrNull(fn: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(fn, path, value);
}

/** Una fecha obligatoria. */
export function date(fn: string, path: string, value: unknown): Date {
  const d = toDate(value);
  if (!d) throw new OutreachShapeError(fn, path, `se esperaba una fecha, llegó ${String(value)}`);
  return d;
}

/** Un entero (pg entrega int como number; count(*) como texto). */
export function int(fn: string, path: string, value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new OutreachShapeError(fn, path, `se esperaba un entero, llegó ${String(value)}`);
  return n;
}

// ---------------------------------------------------------------------
// Enlace de baja y dirección
// ---------------------------------------------------------------------

/** El token del enlace de baja y su sha256 (lo único que guarda la base). */
export function newOptoutToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

/** Las direcciones de una ficha, tal como están en contact. */
export interface ContactAddresses {
  email: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
}

/**
 * La regla de los CHECK de outbound_touch.recipient_address (0037 §4.2),
 * repetida aquí para decirla ANTES de escribir (r2): de 3 a 320
 * caracteres, y en un correo una sola arroba y sin espacios. contact.email
 * no tiene CHECK: una ficha con «carla arroba marca.test» hacía fallar el
 * UPDATE en lote del reclamo, y con él el despachador de toda la
 * plataforma, en cada corrida.
 */
export const RECIPIENT_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export type RecipientCheck = { ok: true; address: string } | { ok: false; reason: 'no_address' | 'invalid_address' };

/** La dirección a la que sale un toque según su canal: la que es, la que falta o la que no sirve. */
export function checkRecipient(channel: string, c: ContactAddresses): RecipientCheck {
  const pick = (v: string | null) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  let address: string | null = null;
  if (channel === 'email') address = pick(c.email)?.toLowerCase() ?? null;
  else if (channel === 'linkedin') address = pick(c.linkedin_url);
  else if (channel === 'instagram_dm') address = pick(c.instagram_handle)?.replace(/^@/, '') ?? null;
  if (address === null) return { ok: false, reason: 'no_address' };
  if (address.length < 3 || address.length > 320) return { ok: false, reason: 'invalid_address' };
  if (channel === 'email' && !RECIPIENT_EMAIL_RE.test(address)) return { ok: false, reason: 'invalid_address' };
  return { ok: true, address };
}

/** La dirección a la que sale un toque según su canal, o null si la ficha no la tiene o no sirve. */
export function recipientFor(channel: string, c: ContactAddresses): string | null {
  const r = checkRecipient(channel, c);
  return r.ok ? r.address : null;
}

// ---------------------------------------------------------------------
// Topes: devolver la plaza que no se gastó (0041 §8)
// ---------------------------------------------------------------------

/** Lo que el reclamo reservó para un toque: la plaza de su cuenta y, si es correo, la del workspace. */
export interface CapReservation {
  workspaceId: string;
  accountId: string;
  channel: string;
  stepType: string | null;
}

/**
 * Devuelve las plazas que el reclamo reservó para un toque que no salió
 * (cancelado, pospuesto, retenido, reintento o devuelto a la cola). Un
 * intento que pudo haber salido (resultado ambiguo, zombi con
 * send_started_at) NO la devuelve: la plaza protege la cuenta.
 */
export async function releaseCaps(tx: WorkerSql, r: CapReservation): Promise<void> {
  await tx.query(`SELECT outbound_counter_release($1::uuid, $2::uuid, $3)`, [r.workspaceId, r.accountId, actionTypeFor(r.stepType, r.channel)]);
  if (r.channel === 'email') {
    await tx.query(`SELECT outbound_counter_release($1::uuid, NULL, 'email')`, [r.workspaceId]);
  }
}

// ---------------------------------------------------------------------
// Correr los pasos de detrás (r2)
// ---------------------------------------------------------------------

/**
 * Cuando un toque de un enrolamiento se mueve (tope, ventana, cuenta
 * caída, pausa), los pasos que van detrás se corren con él y conservan
 * su separación en días hábiles (shiftFollowingSteps de @mc/core). Así
 * el paso 2 («Como te comenté ayer…») nunca sale antes que el 1.
 */
export async function shiftFollowing(
  tx: SqlExecutor,
  moved: { enrollmentId: string | null; dayOffset: number | null; orderInDay: number | null; at: Date },
  timeZone: string,
  window: SendWindow,
): Promise<number> {
  if (!moved.enrollmentId || moved.dayOffset === null || moved.orderInDay === null) return 0;
  const rows = (
    await tx.query<{ id: string; day_offset: number; order_in_day: number; scheduled_for: unknown }>(
      `SELECT t.id, st.day_offset, st.order_in_day, t.scheduled_for
         FROM outbound_touch t JOIN outbound_step st ON st.id = t.step_id
        WHERE t.enrollment_id = $1::uuid AND t.status IN ('draft', 'scheduled', 'held') AND t.scheduled_for IS NOT NULL
          AND (st.day_offset, st.order_in_day) > ($2::int, $3::int)`,
      [moved.enrollmentId, moved.dayOffset, moved.orderInDay],
    )
  ).rows;
  const fn = 'shiftFollowing';
  const shifts = shiftFollowingSteps(
    { dayOffset: moved.dayOffset, orderInDay: moved.orderInDay, at: moved.at },
    rows.map((r, i) => ({
      id: text(fn, `$[${i}].id`, r.id), dayOffset: int(fn, `$[${i}].day_offset`, r.day_offset),
      orderInDay: int(fn, `$[${i}].order_in_day`, r.order_in_day), at: date(fn, `$[${i}].scheduled_for`, r.scheduled_for),
    })),
    timeZone,
    window,
  );
  if (shifts.length === 0) return 0;
  await tx.query(
    `UPDATE outbound_touch t SET scheduled_for = x.at
       FROM unnest($1::uuid[], $2::timestamptz[]) AS x(id, at)
      WHERE t.id = x.id AND t.status IN ('draft', 'scheduled', 'held')`,
    [shifts.map((s) => s.id), shifts.map((s) => s.at.toISOString())],
  );
  return shifts.length;
}
