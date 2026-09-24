/**
 * El utillaje de las pruebas del motor de cadencias (VEN-10): un
 * workspace de prueba en Bogotá con su Gmail conectado, su política
 * encendida y una secuencia de tres correos (día 0, respuesta en el hilo
 * el día 1, día 2), y las lecturas que las pruebas repiten.
 *
 * Cada prueba crea su propio workspace (el despachador filtra por
 * workspaceId) para no depender del orden de las demás. `prefix` separa
 * los uuid de cada archivo de pruebas; `slug` sus workspaces.
 */
import assert from 'node:assert/strict';
import { zonedParts } from '@mc/core';
import { enrollContacts } from '@mc/db/queries/outreach';
import type { ChannelSender } from '../../src/jobs/ventas/canales/types.ts';
import type { DispatchDeps } from '../../src/jobs/ventas/outbound.dispatch.ts';
import type { MotorDb } from '../../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../../src/runner/db-pglite.ts';

export const TZ = 'America/Bogota';
export const W = { start: '09:00', end: '17:00' };
/** Un instante a una hora local de Bogotá (UTC−5, sin horario de verano). */
export const bogota = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);

export function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

export function localDay(at: Date): string {
  const { date } = zonedParts(at, TZ);
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function localClock(at: Date): string {
  const { seconds } = zonedParts(at, TZ);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}

/** Un workspace de prueba: sus ids y los de su secuencia. */
export interface Ws {
  n: number;
  id: string;
  gmail: string;
  seq: string;
  steps: [string, string, string];
  contacts: string[];
  company: string;
}

export interface TouchRow {
  id: string;
  step_id: string;
  status: string;
  attempt_count: number;
  scheduled_for: Date;
  next_retry_at: Date | null;
  blocked_reason: string | null;
  held_reason: string | null;
  unconfirmed_attempt: number | null;
  provider_message_id: string | null;
}

export interface WorkspaceOptions {
  contacts?: number;
  locale?: string;
  /** El primer paso espera al generador (generate_with_ai): nace en borrador. */
  firstStepByAi?: boolean;
  /** Tope diario de la cuenta y calentamiento de la política. */
  dailyCap?: number;
  warmupDays?: number;
  /** Desde cuándo calienta la cuenta (NULL: sin calentamiento). */
  warmupStartedAt?: Date | null;
  /** (r5) La política de la marca y la revisión humana (por defecto: sin tope, sin separación, sin revisión). */
  maxTouchesPerCompany?: number;
  minDaysBetweenTouches?: number;
  humanReview?: boolean;
  /** La zona de la secuencia (NULL: la del workspace). */
  sequenceTimeZone?: string;
}

export function motorKit(opts: { db: () => PgliteDatabase; motor: () => MotorDb; prefix: string; slug: string }) {
  const { db, motor } = opts;

  async function workspace(n: number, o: WorkspaceOptions = {}): Promise<Ws> {
    const base = `${opts.prefix}-${hex(n, 4)}-4000-8000-`;
    const w: Ws = {
      n,
      id: `${base}000000000001`,
      gmail: `${base}0000000ac001`,
      seq: `${base}0000005e0001`,
      steps: [`${base}0000005e0101`, `${base}0000005e0102`, `${base}0000005e0103`],
      contacts: Array.from({ length: o.contacts ?? 2 }, (_, i) => `${base}0000000c${hex(i + 1, 4)}`),
      company: `${base}0000000000c1`,
    };
    const user = `${base}0000000000a1`;
    const contactos = w.contacts
      .map((c, i) => `('${c}', '${w.company}', '${w.id}', 'Persona ${i + 1} Prueba', 'p${i + 1}.${opts.slug}${n}@marca.test', 'user_provided')`)
      .join(', ');
    const warmup = o.warmupStartedAt ? `'${o.warmupStartedAt.toISOString()}'` : 'NULL';
    await db().raw.exec(`
      INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${w.id}', '${opts.slug}-${n}', 'Creadora ${n}', '${TZ}', '${o.locale ?? 'es-CO'}');
      INSERT INTO app_user (id, email, name) VALUES ('${user}', 'creadora${n}@${opts.slug}.test', 'Creadora ${n}');
      INSERT INTO membership (workspace_id, user_id, role) VALUES ('${w.id}', '${user}', 'owner');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${w.company}', 'Marca ${n}', '${w.id}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${w.id}', '${w.company}');
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES ${contactos};
      -- Sin revisión humana, sin tope ni separación con la marca, salvo que
      -- la prueba los pida (r5: el motor los aplica; aquí se prueba lo demás).
      INSERT INTO outbound_policy (workspace_id, enabled, postal_address, max_emails_per_day, warmup_days, require_human_review,
                                   max_touches_per_company, min_days_between_touches)
      VALUES ('${w.id}', false, 'Calle 93 # 11-26, Bogotá, Colombia', 100, ${o.warmupDays ?? 14}, ${o.humanReview ? 'true' : 'false'},
              ${o.maxTouchesPerCompany ?? 50}, ${o.minDaysBetweenTouches ?? 0});
      -- La fila del almacén a la que apunta secret_ref (el cifrado no importa aquí: el canal de la prueba usa su propio almacén).
      INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
      VALUES ('enc:gmail:${opts.slug}${n}', '${w.id}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
      INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap,
                                            weekly_cap, secret_ref, warmup_started_at)
      VALUES ('${w.gmail}', '${w.id}', 'email', 'gmail_oauth', 'creadora${n}@${opts.slug}.test', 'Creadora ${n}', 'connected',
              ${o.dailyCap ?? 40}, 200, 'enc:gmail:${opts.slug}${n}', ${warmup});
      INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode, timezone)
      VALUES ('${w.seq}', '${w.id}', 'Tres correos', 'email', 'active', 'auto', ${o.sequenceTimeZone ? `'${o.sequenceTimeZone}'` : 'NULL'});
      INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                                 subject_template, body_template, generate_with_ai) VALUES
        ('${w.steps[0]}', '${w.id}', '${w.seq}', 0, 0, 'email', 'email', '09:30', 'Hola, {{first_name}}',
         'Hola, {{first_name}}: te escribo por {{company}}.', ${o.firstStepByAi ? 'true' : 'false'}),
        ('${w.steps[1]}', '${w.id}', '${w.seq}', 1, 0, 'email_reply', 'email', '10:00', NULL,
         'Como te comenté ayer, tengo una idea para {{company}}.', false),
        ('${w.steps[2]}', '${w.id}', '${w.seq}', 2, 0, 'email', 'email', '10:00', 'Una última idea',
         'Cierro con mi media kit, {{first_name}}.', false);
      SELECT enable_outreach('${w.id}');
    `);
    return w;
  }

  async function enroll(w: Ws, at: Date, contacts: readonly string[] = w.contacts): Promise<Map<string, string>> {
    const r = await motor().transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: contacts, now: at }));
    assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
    return new Map(r.enrolled.map((e) => [e.contactId, e.enrollmentId]));
  }

  function deps(w: Ws, fake: Partial<Record<string, ChannelSender>>, clock: () => Date, extra: Partial<DispatchDeps> = {}): DispatchDeps {
    return { senders: fake, now: clock, appUrl: 'https://oncue.test', workspaceId: w.id, ...extra };
  }

  /** Los tres toques de un contacto, en el orden de sus pasos. */
  async function touches(contactId: string): Promise<TouchRow[]> {
    const { rows } = await db().raw.query<TouchRow>(
      `SELECT t.id, t.step_id, t.status, t.attempt_count, t.scheduled_for, t.next_retry_at, t.blocked_reason, t.held_reason,
              t.unconfirmed_attempt, t.provider_message_id
         FROM outbound_touch t JOIN outbound_step s ON s.id = t.step_id
        WHERE t.contact_id = $1 ORDER BY s.day_offset, s.order_in_day`,
      [contactId],
    );
    return rows;
  }

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await db().raw.query<{ v: T }>(sql, params);
    return rows[0]!.v;
  }

  /** Mueve la hora de un toque (lo que haría una reprogramación de la web). */
  async function setDue(touchId: string, at: Date): Promise<void> {
    await db().raw.query(`UPDATE outbound_touch SET scheduled_for = $2 WHERE id = $1`, [touchId, at.toISOString()]);
  }

  return { workspace, enroll, deps, touches, scalar, setDue };
}
