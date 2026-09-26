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
import type { WorkspaceTx } from '@mc/db/client';
import { enrollContacts } from '@mc/db/queries/outreach';
import type { ChannelSender } from '../../src/jobs/ventas/canales/types.ts';
import type { DispatchDeps } from '../../src/jobs/ventas/outbound.dispatch.ts';
import type { MotorDb } from '../../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../../src/runner/db-pglite.ts';
import { membershipSql } from '@mc/db/test/membresia';

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
  /** La política de la marca y la revisión humana (por defecto: sin tope, sin separación, sin revisión). */
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
      ${membershipSql([{ workspaceId: w.id, userId: user, kind: 'owner' }])}
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${w.company}', 'Marca ${n}', '${w.id}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${w.id}', '${w.company}');
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES ${contactos};
      -- Sin revisión humana, sin tope ni separación con la marca, salvo que
      -- la prueba los pida (el motor los aplica; aquí se prueba lo demás).
      -- Los tres canales encendidos: desde 0045 (VEN-9) un espacio nuevo
      -- nace sin Instagram, y el motor se prueba también por Instagram.
      INSERT INTO outbound_policy (workspace_id, enabled, postal_address, max_emails_per_day, warmup_days, require_human_review,
                                   max_touches_per_company, min_days_between_touches, allowed_channels)
      VALUES ('${w.id}', false, 'Calle 93 # 11-26, Bogotá, Colombia', 100, ${o.warmupDays ?? 14}, ${o.humanReview ? 'true' : 'false'},
              ${o.maxTouchesPerCompany ?? 50}, ${o.minDaysBetweenTouches ?? 0}, '{email,linkedin,instagram_dm}');
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

  /** Una secuencia más en el workspace: sus pasos (tipo, canal, día, plantilla) y su id. */
  async function secuencia(
    w: Ws, n: number, pasos: Array<{ type: string; channel: string; day: number; body: string; subject?: string }>,
  ): Promise<string> {
    const seq = `${w.id.slice(0, 24)}${hex(0x5e00 + n, 12)}`;
    const filas = pasos.map((p, i) =>
      `('${seq.slice(0, 24)}${hex(0x5e0000 + n * 16 + i, 12)}', '${w.id}', '${seq}', ${p.day}, ${i}, '${p.type}', '${p.channel}', '10:00', ` +
      `${p.subject ? `'${p.subject}'` : 'NULL'}, '${p.body.replace(/'/g, "''")}', false)`,
    );
    await db().raw.exec(`
      INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
      VALUES ('${seq}', '${w.id}', 'Secuencia ${n}', '${pasos[0]!.channel}', 'active', 'auto');
      INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                                 subject_template, body_template, generate_with_ai) VALUES ${filas.join(', ')};
    `);
    return seq;
  }

  /** Una cuenta de Unipile conectada (LinkedIn o Instagram) y la dirección de cada ficha en ese canal. */
  async function unipile(w: Ws, channel: 'linkedin' | 'instagram_dm', dailyCap = 100): Promise<string> {
    const acc = `${w.id.slice(0, 24)}0000000ac0${channel === 'linkedin' ? '02' : '03'}`;
    await db().raw.exec(`
      INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
      VALUES ('${acc}', '${w.id}', '${channel}', 'unipile', 'uni-${channel}-${w.n}', 'Creadora ${w.n}', 'connected', ${dailyCap},
              ${channel === 'linkedin' ? 200 : 700});
      UPDATE contact SET linkedin_url = 'https://www.linkedin.com/in/persona-' || right(id::text, 4),
                         instagram_handle = 'persona_' || right(id::text, 4)
       WHERE owner_workspace_id = '${w.id}';
    `);
    return acc;
  }

  /** Una segunda cuenta de Gmail conectada en el workspace, creada un minuto después de la primera. */
  async function otroGmail(w: Ws, dailyCap: number): Promise<string> {
    const acc = `${w.id.slice(0, 24)}0000000ac0b2`;
    await db().raw.exec(`
      INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
      VALUES ('enc:gmail:${opts.slug}-otro-${w.n}', '${w.id}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
      INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap,
                                            weekly_cap, secret_ref, created_at)
      VALUES ('${acc}', '${w.id}', 'email', 'gmail_oauth', 'agencia${w.n}@${opts.slug}.test', 'Agencia ${w.n}', 'connected', ${dailyCap}, 200,
              'enc:gmail:${opts.slug}-otro-${w.n}', now() + interval '1 minute');
    `);
    return acc;
  }

  /** Marca el correo de una ficha como rebotado (lo que deja VEN-15). */
  async function rebotar(contactId: string): Promise<void> {
    await db().raw.query(
      `UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1 user unknown' WHERE id = $1`,
      [contactId],
    );
  }

  /** La cuenta con la que salió cada toque de un contacto, en el orden de sus pasos. */
  async function cuentas(contactId: string): Promise<Array<string | null>> {
    const { rows } = await db().raw.query<{ acc: string | null }>(
      `SELECT t.channel_account_id AS acc FROM outbound_touch t JOIN outbound_step s ON s.id = t.step_id
        WHERE t.contact_id = $1 ORDER BY s.day_offset, s.order_in_day`,
      [contactId],
    );
    return rows.map((r) => r.acc);
  }

  /**
   * Lo que hace una persona desde la web, con el workspace fijado en la
   * transacción como withWorkspace. Corre como el dueño de la base del
   * arnés del worker (que no le da privilegios a mc_app); el rol mc_app y
   * la RLS de verdad se prueban en packages/db/test.
   */
  async function comoLaWeb<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
    return db().raw.transaction(async (raw) => {
      await raw.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      // Sin persona en la transacción, como la web sin Supabase Auth: lo que el cliente de @mc/db fija con
      // DbOptions.authDisabled (0050 §7). Sin esto, las reglas que fallan cerradas (outreach_can_manage,
      // outreach_resolve_unconfirmed) dirían que no.
      await raw.query(`SELECT set_config('app.auth_disabled', 'on', true)`);
      const tx = {
        workspaceId,
        db: null as never,
        query: async (text: string, params: readonly unknown[] = []) => {
          const r = await raw.query(text, params as unknown[]);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
      } as unknown as WorkspaceTx;
      return fn(tx);
    });
  }

  return { workspace, enroll, deps, touches, scalar, setDue, secuencia, unipile, otroGmail, rebotar, cuentas, comoLaWeb };
}
