/**
 * FIN-4 · finance.reminders: los recordatorios de cobro sobre el seed
 * real. FV-2026-007 (vencida hace 41 días) termina con sus tres
 * recordatorios y reminders_sent = 3; una segunda corrida el mismo día
 * no escribe nada; la factura que vence en 7 días recibe el paso −7 con
 * severidad info; las pagadas no reciben nada; dos workspaces no se
 * cruzan; y en job_run.metadata no hay PII.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pasoDeUrl } from '@mc/core';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(HERE, '..', '..', '..', 'db', 'seed');

/** Ids fijos del seed 0003 (docs/propuestas/CIM-8.md). */
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const FV_007 = '00000003-0000-4000-8000-0000fac26007';
const FV_010 = '00000003-0000-4000-8000-0000fac26010';
const FV_011 = '00000003-0000-4000-8000-0000fac26011';
const FV_001_PAGADA = '00000003-0000-4000-8000-0000fac26001';

/** Un segundo workspace con su propia factura vencida, para la prueba de aislamiento. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000001';
const COMPANY_AJENA = '00000009-0000-4000-8000-0000000000e1';
const FV_AJENA = '00000009-0000-4000-8000-0000fac26001';

let h: Harness;
/** El día que ve la base: el seed escribe due_on con CURRENT_DATE, así que el reloj del job sale de ahí. */
let hoy: string;

async function seed(db: PgliteDatabase): Promise<void> {
  const archivos = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of archivos) await db.raw.exec(await readFile(join(SEED_DIR, f), 'utf8'));
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, settings)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno', 'Estudio Ajeno', 'creator', 'CO', 'COP', 'America/Bogota', 'es-CO',
            -- FIN-8: el ajeno SÍ configuró cómo le pagan; Laura (el seed) no.
            '{"finanzas": {"razon_social": "Estudio Ajeno S.A.S.", "banco": "Banco Ajeno", "cuenta": "Ahorros 999-000111-22"}}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_AJENA}', 'Marca Ajena', '${WORKSPACE_AJENO}')
    ON CONFLICT DO NOTHING;
    INSERT INTO invoice (id, workspace_id, company_id, number, currency, subtotal, tax, withholding, total, issued_on, due_on, status, paid_amount, reminders_sent)
    VALUES ('${FV_AJENA}', '${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'FV-2026-A01', 'COP', 1000000.00, 190000.00, 110000.00, 1190000.00,
            CURRENT_DATE - 71, CURRENT_DATE - 41, 'sent', 0.00, 0)
    ON CONFLICT DO NOTHING;
  `);
  const { rows } = await db.raw.query<{ hoy: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hoy`);
  hoy = rows[0]!.hoy;
}

interface NotifRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  entity_id: string;
  severity: string;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
  read_at: Date | string | null;
  emailed_at: Date | string | null;
  created_at: Date | string;
}

async function recordatorios(invoiceId?: string): Promise<NotifRow[]> {
  const { rows } = await h.db.query<NotifRow>(
    `SELECT id, workspace_id, entity_id, severity, title_es, body_es, action_url, read_at, emailed_at, created_at
       FROM notification
      WHERE kind = 'invoice_overdue' AND ($1::uuid IS NULL OR entity_id = $1)
      ORDER BY action_url`,
    [invoiceId ?? null],
  );
  return rows;
}

async function factura(id: string): Promise<{ reminders_sent: number; last_reminder_at: Date | string | null }> {
  const { rows } = await h.db.query<{ reminders_sent: number; last_reminder_at: Date | string | null }>(
    `SELECT reminders_sent, last_reminder_at FROM invoice WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function correr(): Promise<{ status: string; metadata: Record<string, unknown>; error: string | null }> {
  const antes = (await jobRuns(h.db, 'finance.reminders')).length;
  await h.worker.boss.send('finance.reminders', { source: 'test' }, { singletonKey: `manual-${antes}` });
  const run = await waitFor(
    async () => {
      const rs = (await jobRuns(h.db, 'finance.reminders')).filter((r) => r.status !== 'running');
      return rs.length > antes ? rs[rs.length - 1] : undefined;
    },
    { label: 'finance.reminders', timeoutMs: 30_000 },
  );
  return { status: run.status, metadata: run.metadata, error: run.error };
}

before(async () => {
  h = await startHarness({ jobs: allJobs, seed, now: () => new Date(`${hoy}T10:00:00Z`) });
}, { timeout: 180_000 });
after(async () => {
  await h.stop();
});

test('la factura vencida hace 41 días termina con sus TRES recordatorios y reminders_sent = 3', async () => {
  const run = await correr();
  assert.equal(run.status, 'ok', run.error ?? '');

  const filas = await recordatorios(FV_007);
  assert.equal(filas.length, 3, 'pasos 2 (día 0), 3 (+7) y 4 (+21); el −7 caducó al vencer');
  assert.deepEqual(filas.map((f) => pasoDeUrl(f.action_url)), [2, 3, 4]);
  assert.deepEqual(filas.map((f) => f.severity), ['info', 'warning', 'warning']);
  for (const f of filas) {
    assert.equal(f.workspace_id, WORKSPACE);
    assert.equal(f.action_url, `/finanzas/facturas/${FV_007}?recordatorio=${pasoDeUrl(f.action_url)}`);
    assert.equal(f.read_at, null, 'nace sin marcar');
    assert.equal(f.emailed_at, null, 'FIN-4 no envía nada');
    assert.match(f.body_es ?? '', /^Hola, equipo de Hogar Lindo:/);
    assert.match(f.body_es ?? '', /COP 1\.100\.000/);
  }
  assert.match(filas[0]?.title_es ?? '', /^La factura FV-2026-007 venció el \d+ de \w+ de \d{4}$/);
  assert.match(filas[1]?.title_es ?? '', /^Factura FV-2026-007 pendiente · 41 días de mora$/);
  assert.match(filas[2]?.title_es ?? '', /^Segundo aviso · factura FV-2026-007 con 41 días de mora$/);

  const inv = await factura(FV_007);
  assert.equal(inv.reminders_sent, 3, 'el contador coincide con las filas de la bandeja');
  assert.notEqual(inv.last_reminder_at, null);
});

test('una segunda corrida el mismo día no crea nada: idempotente por (factura, paso)', async () => {
  const antes = await recordatorios();
  const run = await correr();
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(run.metadata['emitted'], 0);
  const despues = await recordatorios();
  assert.deepEqual(despues.map((f) => f.id), antes.map((f) => f.id), 'las mismas filas, sin duplicados');
  assert.equal((await factura(FV_007)).reminders_sent, 3);
});

test('la factura que vence en 7 días recibe el paso −7 con severidad info, y la de 23 días nada', async () => {
  const siete = await recordatorios(FV_010);
  assert.equal(siete.length, 1);
  assert.equal(pasoDeUrl(siete[0]!.action_url), 1);
  assert.equal(siete[0]!.severity, 'info');
  assert.match(siete[0]!.title_es, /^Recordatorio: la factura FV-2026-010 vence el /);
  assert.match(siete[0]!.body_es ?? '', /vence en 7 días/);
  assert.equal((await factura(FV_010)).reminders_sent, 1);

  assert.deepEqual(await recordatorios(FV_011), [], 'faltan 23 días: todavía no toca');
  assert.equal((await factura(FV_011)).reminders_sent, 0);
});

test('una factura pagada no recibe nada, y su contador no se toca', async () => {
  assert.deepEqual(await recordatorios(FV_001_PAGADA), []);
  const inv = await factura(FV_001_PAGADA);
  assert.equal(inv.reminders_sent, 0);
  assert.equal(inv.last_reminder_at, null);
});

test('dos workspaces no se cruzan: cada recordatorio lleva el suyo', async () => {
  const ajenos = await recordatorios(FV_AJENA);
  assert.equal(ajenos.length, 3, 'la factura ajena tiene los suyos');
  for (const f of ajenos) assert.equal(f.workspace_id, WORKSPACE_AJENO);
  assert.match(ajenos[0]!.body_es ?? '', /Marca Ajena/);

  const todos = await recordatorios();
  const porWorkspace = new Map<string, Set<string>>();
  for (const f of todos) porWorkspace.set(f.workspace_id, new Set([...(porWorkspace.get(f.workspace_id) ?? []), f.entity_id]));
  assert.deepEqual([...porWorkspace.get(WORKSPACE_AJENO)!], [FV_AJENA]);
  assert.ok(!porWorkspace.get(WORKSPACE)!.has(FV_AJENA));

  const { rows } = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification n JOIN invoice i ON i.id = n.entity_id
      WHERE n.kind = 'invoice_overdue' AND n.workspace_id <> i.workspace_id`,
  );
  assert.equal(rows[0]!.n, '0', 'ninguna notificación apunta a una factura de otro workspace');
});

test('costura FIN-8 → FIN-4: cada correo lleva los datos de pago de SU workspace, o la frase de dónde configurarlos', async () => {
  const ajenos = await recordatorios(FV_AJENA);
  for (const r of ajenos) {
    assert.match(r.body_es ?? '', /A nombre de: Estudio Ajeno S\.A\.S\./);
    assert.match(r.body_es ?? '', /Banco: Banco Ajeno/);
    assert.match(r.body_es ?? '', /Cuenta: Ahorros 999-000111-22/);
  }
  // El seed de Laura no tiene banco ni cuenta: su correo dice dónde se configuran.
  const deLaura = await recordatorios(FV_007);
  assert.ok(deLaura.length > 0);
  for (const r of deLaura) {
    assert.match(r.body_es ?? '', /Finanzas → Configuración → «Cómo te pagan»/);
    assert.doesNotMatch(r.body_es ?? '', /Banco Ajeno/, 'los datos de otro workspace no se cruzan');
  }
});

test('job_run.metadata lleva conteos e ids, y ni una cifra, ni un nombre, ni el texto del correo', async () => {
  const runs = await jobRuns(h.db, 'finance.reminders');
  const primera = runs[0]!;
  assert.equal(primera.status, 'ok');
  const md = primera.metadata as { invoices: number; emitted: number; skipped: number; failed: number; byStep: Record<string, number>; emittedIds: string[] };
  assert.equal(md.emitted, 3, 'FV-2026-007, FV-2026-010 y la ajena');
  assert.equal(md.failed, 0);
  assert.deepEqual(md.byStep, { '1': 1, '2': 2, '3': 2, '4': 2 }, 'el paso 1 solo lo recibe FV-2026-010');
  assert.deepEqual([...md.emittedIds].sort(), [FV_007, FV_010, FV_AJENA].sort());
  const texto = JSON.stringify(primera.metadata);
  for (const prohibido of ['Hogar Lindo', 'Marca Ajena', 'FV-2026-007', 'Hola, equipo', '1100000', 'COP', 'Banco Ajeno', '999-000111']) {
    assert.ok(!texto.includes(prohibido), `metadata no debe llevar "${prohibido}": ${texto}`);
  }
});

test('el log del job no imprime el cuerpo del correo ni el nombre de la marca', () => {
  const texto = h.sink.text();
  assert.ok(texto.includes('recordatorios redactados'), 'algo tuvo que registrar');
  assert.ok(texto.includes('FV-2026-007'), 'el número de factura sí: es un identificador, y sin él no se sabe de cuál habla');
  for (const prohibido of ['Hola, equipo', 'Hogar Lindo', 'Marca Ajena', 'Banco Ajeno', '999-000111']) {
    assert.ok(!texto.includes(prohibido), `el log no debe llevar "${prohibido}"`);
  }
});

test('pasoDeUrl solo acepta los cinco pasos', () => {
  assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=4'), 4);
  assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=1&otro=2'), 1);
  assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=0'), null);
  assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=6'), null);
  assert.equal(pasoDeUrl('/finanzas/facturas/x'), null);
  assert.equal(pasoDeUrl(null), null);
});
