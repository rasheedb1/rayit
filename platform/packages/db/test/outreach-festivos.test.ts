/**
 * VEN-10 · los festivos del país del workspace no son hábiles: el
 * despachador no manda outreach en frío el lunes festivo del 12 de
 * octubre en Colombia (lo pasa a la apertura del martes), y un workspace
 * de un país sin tabla de festivos envía ese lunes como cualquier otro.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedParts } from '@mc/core';
import { claimDueTouches } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

/** El lunes 12 de octubre de 2026 a las 10:00 en Bogotá: festivo en Colombia (Día de la Raza, Ley Emiliani). */
const CLOCK = new Date('2026-10-12T10:00:00-05:00');
const CO_WS = randomUUID();
const MX_WS = randomUUID();
const toques = { co: randomUUID(), mx: randomUUID() };

let t: TestDb;

function espacio(ws: string, country: string, touch: string): string {
  const slug = `festivos-${ws.slice(0, 8)}`;
  const co = randomUUID();
  const ct = randomUUID();
  return `
    INSERT INTO workspace (id, slug, name, timezone, country) VALUES ('${ws}', '${slug}', 'Festivos', 'America/Bogota', '${country}');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review)
    VALUES ('${ws}', true, 'Calle 93 # 11-26, Bogotá', false);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${ws}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status, secret_ref)
    VALUES ('${ws}', 'email', 'gmail_oauth', '${slug}@marca-propia.test', 'Laura', 'connected', 'enc:gmail:${slug}');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${co}', 'Marca ${slug}', '${ws}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${ws}', '${co}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${ct}', '${co}', '${ws}', 'Persona', 'persona.${slug}@marca.test', 'user_provided');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for)
    VALUES ('${touch}', '${ws}', '${co}', '${ct}', 'email', 'Hola', 'Una idea.', 'scheduled', '${new Date(CLOCK.getTime() - 30 * 60_000).toISOString()}');`;
}

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(espacio(CO_WS, 'CO', toques.co) + espacio(MX_WS, 'MX', toques.mx));
}, SETUP_TIMEOUT);
after(async () => {
  if (t?.kind === 'postgres') {
    await t.admin(`DELETE FROM workspace WHERE id IN ('${CO_WS}', '${MX_WS}'); DELETE FROM company WHERE name LIKE 'Marca festivos-%'`);
  }
  await t?.close();
});

test('el lunes festivo en Colombia no sale: espera a la apertura del martes, sin gastar intento', async () => {
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: CO_WS }));
  assert.deepEqual(r.claimed, []);
  const fuera = r.outsideWindow.find((x) => x.touchId === toques.co);
  assert.ok(fuera, 'queda fuera de la ventana: el día no es hábil');
  const { date, seconds } = zonedParts(fuera.until, 'America/Bogota');
  assert.deepEqual(date, { year: 2026, month: 10, day: 13 });
  assert.ok(seconds >= 9 * 3600 && seconds < 17 * 3600, 'dentro de la ventana del martes');
});

test('en un país sin tabla de festivos ese lunes es hábil y el mensaje sale', async () => {
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: MX_WS }));
  assert.deepEqual(r.claimed.map((c) => c.id), [toques.mx]);
});
