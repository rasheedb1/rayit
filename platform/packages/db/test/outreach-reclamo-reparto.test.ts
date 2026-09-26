/**
 * VEN-10 · el reclamo reparte entre workspaces: un workspace con muchos
 * atrasados (al volver a encender el envío) no se lleva las corridas de
 * los demás. Primero sale el más viejo de CADA workspace, después el
 * segundo de cada uno, y así.
 *
 * Solo en PGlite: el reclamo sin workspace toma de todos, y contra el
 * Postgres compartido del CI se llevaría los toques de otros archivos.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { claimDueTouches } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

/** Un miércoles a mediodía en Bogotá: dentro de la ventana laboral. */
const CLOCK = new Date('2026-09-23T12:00:00-05:00');
const GRANDE = randomUUID();
const PEQUENO = randomUUID();
/** Cuántos atrasados tiene el grande, y cuántos el pequeño. */
const N_GRANDE = 12;
const N_PEQUENO = 2;
const mias = { grande: [] as string[], pequeno: [] as string[] };

let t: TestDb;

/** Un workspace con su política encendida, su Gmail y `n` toques vencidos a marcas distintas, desde `hace` minutos. */
function espacio(ws: string, n: number, hace: number, ids: string[]): string {
  const slug = `reparto-${ws.slice(0, 8)}`;
  const filas: string[] = [];
  for (let i = 0; i < n; i++) {
    const co = randomUUID();
    const ct = randomUUID();
    const tk = randomUUID();
    ids.push(tk);
    const due = new Date(CLOCK.getTime() - (hace - i) * 60_000).toISOString();
    filas.push(`
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${co}', 'Marca ${i} ${slug}', '${ws}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${ws}', '${co}');
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
      VALUES ('${ct}', '${co}', '${ws}', 'Persona ${i}', 'p${i}.${slug}@marca.test', 'user_provided');
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for)
      VALUES ('${tk}', '${ws}', '${co}', '${ct}', 'email', 'Hola', 'Una idea.', 'scheduled', '${due}');`);
  }
  return `
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${ws}', '${slug}', 'Reparto', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_emails_per_day)
    VALUES ('${ws}', true, 'Calle 93 # 11-26, Bogotá', false, 100);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${ws}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status,
                                          daily_cap, weekly_cap, secret_ref)
    VALUES ('${ws}', 'email', 'gmail_oauth', '${slug}@marca-propia.test', 'Laura', 'connected', 100, 500, 'enc:gmail:${slug}');
    ${filas.join('\n')}`;
}

before(async () => {
  t = await openTestDb({ seeds: false });
  // El grande se atrasó primero (hace 60 minutos); el pequeño, después (hace 5).
  // Solo en la base propia del archivo (ver la cabecera): en un Postgres compartido, ni se siembra.
  if (t.kind === 'pglite') await t.admin(espacio(GRANDE, N_GRANDE, 60, mias.grande) + espacio(PEQUENO, N_PEQUENO, 5, mias.pequeno));
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

test('con cuatro plazas, los dos del pequeño salen en la primera corrida aunque el grande tenga doce más viejos', async (ctx) => {
  // El reclamo de verdad es de TODOS los workspaces: contra un Postgres compartido con otros archivos (y la demo
  // sembrada) se llevaría sus toques. La regla es SQL puro y se mide igual en PGlite.
  if (t.kind !== 'pglite') return ctx.skip('reclamo global: solo en la base propia de este archivo');
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], limit: 4 }));
  const ids = r.claimed.map((c) => c.id);
  assert.equal(ids.length, 4);
  for (const id of mias.pequeno) assert.ok(ids.includes(id), 'el pequeño no espera a que el grande se vacíe');
  // Y del grande, sus dos más viejos: dentro de cada workspace se respeta el orden de llegada.
  assert.deepEqual(ids.filter((id) => mias.grande.includes(id)).sort(), mias.grande.slice(0, 2).sort());
});
