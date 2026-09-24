/**
 * `job:dispatch -- --demo` · el motor contra el seed, sin Supabase ni red (VEN-10).
 *
 * Levanta Postgres embebido con TODAS las migraciones y los seeds del
 * repositorio (los mismos archivos y el mismo runner que `make
 * db.migrate` y `make db.seed`) y corre el despachador y el lector de
 * respuestas como mc_worker con el canal falso. Cuenta la historia entera
 * (r3):
 *
 *   1. Con la política del seed, que viene APAGADA: no se reclama nada.
 *   2. Encendida, con el LinkedIn de la demo reconectado (el seed lo deja
 *      en needs_reconnect; aquí se hace lo que haría el callback de
 *      Unipile): el mensaje de LinkedIn que el seed dejó programado para
 *      Vitalé espera (r5): la política del seed pide tres días entre
 *      mensajes a la misma marca y el seed le mandó un correo ayer.
 *   3. Cuando se cumplen, sale.
 *   4. Una secuencia de tres correos (días 0, 3 y 6: la separación de la
 *      política; el segundo es la respuesta en el hilo) con dos marcas
 *      enroladas desde ayer. La política del seed pide revisión humana
 *      (r5): los mensajes nacen retenidos y la creadora los aprueba como
 *      en la ficha (releaseHeldTouch, con la RLS de su espacio). Sus dos
 *      primeros correos, ya vencidos, salen con su pie (la página de baja
 *      y la dirección postal) y su cabecera de baja de un clic.
 *   5. Una de las dos marcas responde: el lector de respuestas lo ve y lo
 *      pendiente de su cadencia queda cancelado.
 *   6. Tres días hábiles después sale el segundo correo de la otra, en el hilo.
 *
 * La secuencia de tres correos se crea en la base embebida, no en el
 * seed: el seed 0005 (VEN-9) ya está sembrado y verificado, y su
 * secuencia es de revisión con pasos generados por IA, que el motor deja
 * en borrador para VEN-12.
 */
import { DEFAULT_SEND_WINDOW, nextBusinessSlot, nextWindowSlot } from '@mc/core';
import { enableOutreach, enrollContacts, releaseHeldTouch } from '@mc/db/queries/outreach';
import { fakeChannels } from './canales/fake.ts';
import { motorDbFromClient } from './motor-db.ts';
import { runDispatch, type DispatchReport } from './outbound.dispatch.ts';
import { runReplies, type RepliesReport } from './outbound.replies.ts';

/** El workspace de la demo (Laura · Cocina fácil), el del seed 0002. */
export const DEMO_WORKSPACE_ID = '00000002-0000-4000-8000-000000000001';
/** Los workspaces de demostración: los únicos donde el canal falso puede correr contra una base compartida. */
export const DEMO_WORKSPACE_IDS = [DEMO_WORKSPACE_ID] as const;

export interface DemoTouch {
  id: string;
  status: string;
  scheduled_for: Date;
  sent_at: Date | null;
  provider_message_id: string | null;
  thread_ref: string | null;
}

export interface DemoDelivery {
  touchId: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  /** La cabecera List-Unsubscribe (solo correo). */
  unsubscribeUrl: string | null;
  threadRef: string;
}

export interface DemoMotorReport {
  /** La pasada con la política apagada, con el toque ya vencido. */
  off: DispatchReport;
  /** La pasada con la política encendida y el reloj en la hora del toque: la separación con la marca lo hace esperar (r5). */
  on: DispatchReport;
  /** La pasada cuando se cumple la separación: sale. */
  later: DispatchReport;
  laterClock: Date;
  /** Los toques de la demo que esa pasada dejó enviados, leídos de la base. */
  sentTouches: DemoTouch[];
  /** La hora a la que se movió el reloj en la segunda pasada. */
  clock: Date;
  /** Cuentas que la demo reconectó antes de la segunda pasada. */
  reconnected: number;
  /** La cadencia de tres correos. */
  cadence: {
    brands: Array<{ contactId: string; name: string; email: string }>;
    /** Los mensajes que la creadora aprobó (nacen retenidos: la revisión humana del seed). */
    approved: number;
    first: DispatchReport;
    replies: RepliesReport;
    next: DispatchReport;
    nextClock: Date;
    /** El estado de los tres toques de cada marca al final. */
    statuses: Array<{ name: string; statuses: string[] }>;
  };
  /** Todo lo que el buzón falso recibió, en orden. */
  delivered: DemoDelivery[];
}

const STEPS = [
  { day: 0, type: 'email', time: '10:00', subject: 'Una idea para {{company}}',
    body: 'Hola, {{first_name}}: cocino para 180 mil personas que compran lo que ven en mis recetas. Tengo una idea para {{company}}.' },
  { day: 3, type: 'email_reply', time: '10:30', subject: null,
    body: 'Como te comenté el otro día, {{first_name}}: te dejo mi media kit por si quieres verlo.' },
  { day: 6, type: 'email', time: '11:00', subject: 'La última, {{first_name}}',
    body: 'Cierro por aquí para no llenarte el correo. Si en algún momento te sirve, aquí estoy.' },
] as const;

export async function runDemoMotor(): Promise<DemoMotorReport> {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  const db = await createEmbeddedDb();
  try {
    const motor = motorDbFromClient(db);
    const fake = fakeChannels();
    const appUrl = 'https://oncue.test';

    // El siguiente toque programado de la demo: el reloj de las dos
    // primeras pasadas se pone un minuto después, cuando ya está vencido.
    // Así lo único que cambia entre una y otra es el interruptor.
    const next = await db.asWorker(async (tx) =>
      (await tx.query<{ scheduled_for: Date; tz: string; w_start: string | null; w_end: string | null }>(
        `SELECT t.scheduled_for, w.timezone AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
           FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
           LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
          WHERE t.workspace_id = $1 AND t.status = 'scheduled'
          ORDER BY t.scheduled_for LIMIT 1`,
        [DEMO_WORKSPACE_ID],
      )).rows[0] ?? null,
    );
    if (!next) throw new Error('El seed no dejó ningún toque programado en el workspace de la demo.');
    // Un minuto después, y dentro de la ventana laboral: el despachador no
    // envía de noche ni en fin de semana (si mañana es sábado, el lunes).
    const window = next.w_start && next.w_end ? { start: next.w_start, end: next.w_end } : DEFAULT_SEND_WINDOW;
    const clock = nextWindowSlot(new Date(new Date(next.scheduled_for).getTime() + 60_000), next.tz, window);

    // La dirección postal del pie (sin ella el interruptor no se enciende)
    // y la cuenta de LinkedIn reconectada.
    const reconnected = await db.asWorker(async (tx) => {
      await tx.query(
        `UPDATE outbound_policy SET postal_address = COALESCE(postal_address, $2) WHERE workspace_id = $1`,
        [DEMO_WORKSPACE_ID, 'Carrera 7 # 71-21, Bogotá, Colombia'],
      );
      return (await tx.query(
        `UPDATE outreach_channel_account
            SET status = 'connected', last_ok_at = now(), last_error = NULL, last_error_at = NULL
          WHERE workspace_id = $1 AND status = 'needs_reconnect'
          RETURNING id`,
        [DEMO_WORKSPACE_ID],
      )).rows.length;
    });

    const off = await runDispatch(motor, { senders: fake, appUrl, now: () => clock, workspaceId: DEMO_WORKSPACE_ID });
    await db.asWorker((tx) => enableOutreach(tx, DEMO_WORKSPACE_ID));
    const on = await runDispatch(motor, { senders: fake, appUrl, now: () => clock, workspaceId: DEMO_WORKSPACE_ID });
    // (r5) La separación con la marca lo movió: el reloj va a esa hora.
    const waitUntil = on.claim.paced.reduce<Date | null>((m, x) => (!m || x.until > m ? x.until : m), null);
    const laterClock = waitUntil ? nextWindowSlot(new Date(waitUntil.getTime() + 60_000), next.tz, window) : clock;
    const later = waitUntil
      ? await runDispatch(motor, { senders: fake, appUrl, now: () => laterClock, workspaceId: DEMO_WORKSPACE_ID })
      : on;
    const sentTouches = later.sent.length === 0 ? [] : await db.asWorker(async (tx) =>
      (await tx.query<DemoTouch>(
        `SELECT id, status, scheduled_for, sent_at, provider_message_id, thread_ref
           FROM outbound_touch WHERE id = ANY($1::uuid[]) ORDER BY scheduled_for`,
        [later.sent],
      )).rows,
    );

    // La cadencia de tres correos, con dos marcas del embudo de Laura que
    // tienen correo y nadie les escribe todavía. Enroladas ayer: su primer
    // correo ya venció.
    const { sequenceId, brands } = await db.asWorker(async (tx) => {
      const seq = (await tx.query<{ id: string }>(
        `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode)
         VALUES ($1, 'Demo del motor · tres correos', 'email', 'active', 'auto') RETURNING id`,
        [DEMO_WORKSPACE_ID],
      )).rows[0]!.id;
      for (const s of STEPS) {
        await tx.query(
          `INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                                      subject_template, body_template, generate_with_ai)
           VALUES ($1, $2, $3, 0, $4, 'email', $5::time, $6, $7, false)`,
          [DEMO_WORKSPACE_ID, seq, s.day, s.type, s.time, s.subject, s.body],
        );
      }
      const picked = (await tx.query<{ contactId: string; name: string; email: string }>(
        `SELECT c.id AS "contactId", c.full_name AS name, c.email::text AS email
           FROM contact c
          WHERE contact_visible_to(c.id, $1) AND c.email IS NOT NULL AND NOT c.opted_out AND NOT address_is_suppressed(c.email)
            AND NOT EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.contact_id = c.id)
          ORDER BY c.full_name LIMIT 2`,
        [DEMO_WORKSPACE_ID],
      )).rows;
      return { sequenceId: seq, brands: picked };
    });
    if (brands.length < 2) throw new Error('El seed no tiene dos marcas con correo libres para la cadencia de la demo.');
    const yesterday = new Date(laterClock.getTime() - 24 * 3600_000);
    const enrolled = await motor.transaction((tx) =>
      enrollContacts(tx, { sequenceId, contactIds: brands.map((b) => b.contactId), now: yesterday }),
    );
    const byContact = new Map(enrolled.enrolled.map((e) => [e.contactId, e.enrollmentId]));
    // (r5) La revisión humana del seed: los mensajes nacen retenidos
    // (needs_review) y la creadora los aprueba tal cual, como en la ficha.
    const approved = await db.withWorkspace(DEMO_WORKSPACE_ID, async (tx) => {
      const held = (await tx.query<{ id: string; subject: string | null; body: string }>(
        `SELECT id, subject, body FROM outbound_touch WHERE enrollment_id = ANY($1::uuid[]) AND status = 'held'`,
        [[...byContact.values()]],
      )).rows;
      let n = 0;
      for (const h of held) if ((await releaseHeldTouch(tx, h.id, { subject: h.subject, body: h.body })).ok) n++;
      return n;
    });
    // El reloj, cuando ya vencieron los dos primeros correos (si «ayer» fue
    // domingo, el día 0 es hoy a su hora).
    const firstDue = await db.asWorker(async (tx) =>
      (await tx.query<{ at: Date | null }>(
        `SELECT max(t.scheduled_for) AS at FROM outbound_touch t JOIN outbound_step st ON st.id = t.step_id
          WHERE t.enrollment_id = ANY($1::uuid[]) AND st.day_offset = 0`,
        [[...byContact.values()]],
      )).rows[0]?.at ?? null,
    );
    const firstClock = firstDue && new Date(firstDue).getTime() + 60_000 > laterClock.getTime()
      ? new Date(new Date(firstDue).getTime() + 60_000)
      : laterClock;
    const first = await runDispatch(motor, { senders: fake, appUrl, now: () => firstClock, workspaceId: DEMO_WORKSPACE_ID });

    // La primera marca responde una hora después.
    const answering = brands[0]!;
    const thread = fake.email.sent.find((m) => m.recipient === answering.email)?.threadRef;
    const replyAt = new Date(firstClock.getTime() + 3600_000);
    if (thread) fake.email.reply(thread, '¡Hola, Laura! Nos encanta la idea. ¿Hablamos el jueves?', replyAt);
    const replies = await runReplies(motor, { readers: fake, now: () => replyAt, workspaceId: DEMO_WORKSPACE_ID });

    // Tres días hábiles después, pasada la hora del segundo paso: solo le
    // escribe a la otra. Si la separación con la marca todavía no se cumple,
    // el reloj va a la hora que dice el despachador (como mucho, dos veces).
    let nextClock = firstClock;
    for (let i = 0; i < 3; i++) nextClock = nextBusinessSlot(nextClock, next.tz, window);
    nextClock = new Date(nextClock.getTime() + 3 * 3600_000);
    let nextRun = await runDispatch(motor, { senders: fake, appUrl, now: () => nextClock, workspaceId: DEMO_WORKSPACE_ID });
    for (let i = 0; i < 2 && nextRun.sent.length === 0 && nextRun.claim.paced.length > 0; i++) {
      const until = nextRun.claim.paced.reduce((m, x) => (x.until > m ? x.until : m), nextClock);
      const at = nextWindowSlot(new Date(until.getTime() + 60_000), next.tz, window);
      nextClock = at;
      nextRun = await runDispatch(motor, { senders: fake, appUrl, now: () => at, workspaceId: DEMO_WORKSPACE_ID });
    }

    const statuses = await db.asWorker(async (tx) =>
      Promise.all(brands.map(async (b) => ({
        name: b.name,
        statuses: (await tx.query<{ status: string }>(
          `SELECT t.status FROM outbound_touch t JOIN outbound_step s ON s.id = t.step_id
            WHERE t.enrollment_id = $1 ORDER BY s.day_offset`,
          [byContact.get(b.contactId)],
        )).rows.map((r) => r.status),
      }))),
    );
    const delivered = Object.values(fake).flatMap((ch) =>
      ch.sent.map((m) => ({
        touchId: m.touchId, channel: m.channel, recipient: m.recipient, subject: m.subject, body: m.body,
        unsubscribeUrl: m.unsubscribeUrl, threadRef: m.threadRef,
      })),
    );
    return {
      off, on, later, laterClock, sentTouches, clock, reconnected, delivered,
      cadence: { brands, approved, first, replies, next: nextRun, nextClock, statuses },
    };
  } finally {
    await db.close();
  }
}

const CHANNEL_NAME: Record<string, string> = { email: 'Correo', linkedin: 'LinkedIn', instagram_dm: 'Instagram' };

/** Lo que sale en la terminal: la historia, paso por paso. */
export function resumenDemo(r: DemoMotorReport): string {
  const l: string[] = [
    'Demo del motor sobre Postgres embebido con las migraciones y los seeds del repositorio, canal falso (nada sale de la máquina).',
    `Reloj en ${r.clock.toISOString()}: el toque del seed ya vencido, dentro de la ventana laboral; ${r.reconnected} cuenta(s) reconectada(s).`,
    '',
    `1. Política del seed (apagada): ${r.off.claim.claimed} reclamado(s), ${r.off.sent.length} enviado(s).`,
    `2. Política encendida: ${r.on.claim.claimed} reclamado(s), ${r.on.sent.length} enviado(s), ` +
      `${r.on.retried.length} a reintento, ${r.on.failed.length} fallido(s), ${r.on.held.length} retenido(s), ` +
      `${r.on.claim.paced.length} esperando la separación con la marca (tres días entre mensajes, la política del seed).`,
    `3. ${r.laterClock.toISOString()}: se cumple la separación. ${r.later.claim.claimed} reclamado(s), ${r.later.sent.length} enviado(s).`,
  ];
  for (const t of r.sentTouches) {
    l.push(`   · outbound_touch ${t.id}: ${t.status}, provider_message_id ${t.provider_message_id}, hilo ${t.thread_ref}`);
  }
  const c = r.cadence;
  l.push(
    '',
    `4. Cadencia de tres correos (días 0, 3 y 6), ${c.brands.map((b) => b.name).join(' y ')} enroladas ayer. ` +
      `Revisión humana encendida: la creadora aprueba ${c.approved} mensaje(s); salen ${c.first.sent.length} correo(s).`,
  );
  const firstEmail = r.delivered.find((d) => d.channel === 'email');
  if (firstEmail) {
    l.push(`   Así sale el de ${firstEmail.recipient} («${firstEmail.subject ?? ''}»):`);
    for (const line of firstEmail.body.split('\n')) l.push(`   │ ${line}`);
    l.push(`   List-Unsubscribe: <${firstEmail.unsubscribeUrl ?? 'sin https: solo el pie'}>  (la baja de un clic, RFC 8058)`);
  }
  l.push(
    '',
    `5. ${c.brands[0]!.name} responde: ${c.replies.inbound} respuesta(s) leída(s), ${c.replies.canceled} toque(s) pendiente(s) cancelado(s).`,
    `6. Tres días hábiles después (${c.nextClock.toISOString()}): ${c.next.sent.length} enviado(s), solo a quien no respondió.`,
  );
  for (const s of c.statuses) l.push(`   · ${s.name}: ${s.statuses.join(' → ')}`);
  l.push('', 'Todo lo que recibió el buzón falso:');
  for (const d of r.delivered) {
    const what = d.subject ? `«${d.subject}»` : `mensaje de ${CHANNEL_NAME[d.channel] ?? d.channel}`;
    l.push(`   · ${CHANNEL_NAME[d.channel] ?? d.channel} a ${d.recipient}: ${what}, hilo ${d.threadRef}`);
  }
  return `${l.join('\n')}\n`;
}
