/**
 * ACC-5: «qué puedo hacer en este espacio» sale de mi membresía en el
 * workspace de la transacción (membership.role_id → role_permission,
 * 0034) y de nada más.
 *
 * Corre como mc_app sobre Postgres embebido con el seed. La dueña del
 * seed recibe exactamente la matriz del Dueño de @mc/core; un Contador
 * y un Mánager insertados aquí (el seed no los trae) reciben la suya:
 * el Contador sin campanas.campana.ver y el Mánager sin
 * finanzas.factura.ver; quien no es miembro, nada; la misma persona
 * desde OTRO workspace, nada; y sin identidad fijada —el modo demo—
 * nada: nadie recibe permisos por omisión.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { permisosDeRol, type RoleKey, type WorkspaceKind } from '@mc/core';
import { getSessionPermissions } from '../src/queries/accesos.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = '00000002-0000-4000-8000-000000000002';
const CONTADORA = '0000000e-0000-4000-8000-000000000001';
const MANAGER = '0000000e-0000-4000-8000-000000000004';
/** Alguien con cuenta pero sin membresía en ningún espacio. */
const NADIE = '0000000e-0000-4000-8000-000000000002';
/** Un segundo espacio, de agencia, donde Laura no es nadie. */
const WS_AGENCIA = '0000000e-0000-4000-8000-0000000000a1';
const AGENTE = '0000000e-0000-4000-8000-000000000003';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO app_user (id, email, name) VALUES
      ('${CONTADORA}', 'contadora@ejemplo.test', 'Contadora Uno'),
      ('${MANAGER}', 'manager@ejemplo.test', 'Mánager Uno'),
      ('${NADIE}', 'nadie@ejemplo.test', 'Sin Espacio'),
      ('${AGENTE}', 'agente@ejemplo.test', 'Agente Uno');
    INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_AGENCIA}', 'agencia-uno', 'Agencia Uno', 'agency');
    SELECT set_config('app.workspace_id', '${WORKSPACE_LAURA}', false);
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES
      ('${WORKSPACE_LAURA}', '${CONTADORA}', system_role_id('creator', 'finance')),
      ('${WORKSPACE_LAURA}', '${MANAGER}', system_role_id('creator', 'manager'));
    SELECT set_config('app.workspace_id', '${WS_AGENCIA}', false);
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_AGENCIA}', '${AGENTE}', system_role_id('agency', 'admin'));
    SELECT set_config('app.workspace_id', '', false);
  `);
}, { timeout: 120_000 });

after(async () => {
  await t?.close();
});

const misPermisos = (ws: string, userId?: string) =>
  t.db.withWorkspace(ws, (tx) => getSessionPermissions(tx), userId ? { userId } : undefined);

/** La matriz de @mc/core, ordenada como la devuelve la consulta. */
const matriz = (kind: WorkspaceKind, key: RoleKey) => [...permisosDeRol(kind, key)].sort();

describe('getSessionPermissions', () => {
  test('la dueña del seed recibe exactamente la matriz del Dueño de creador', async () => {
    assert.deepEqual(await misPermisos(WORKSPACE_LAURA, LAURA), matriz('creator', 'owner'));
  });

  test('Contador: su matriz, con Finanzas y sin campanas.campana.ver (terminado cuando de ACC-5)', async () => {
    const p = await misPermisos(WORKSPACE_LAURA, CONTADORA);
    assert.deepEqual(p, matriz('creator', 'finance'));
    assert.ok(p.includes('finanzas.factura.ver'));
    assert.ok(!p.includes('campanas.campana.ver'));
  });

  test('Mánager: Campañas sí, y ni finanzas.factura.ver ni finanzas.flujo.ver (decisión E)', async () => {
    const p = await misPermisos(WORKSPACE_LAURA, MANAGER);
    assert.deepEqual(p, matriz('creator', 'manager'));
    assert.ok(p.includes('campanas.campana.ver'));
    assert.ok(!p.includes('finanzas.factura.ver'));
    assert.ok(!p.includes('finanzas.flujo.ver'));
  });

  test('el tipo del workspace cuenta: el administrador de la agencia recibe la matriz de agencia', async () => {
    assert.deepEqual(await misPermisos(WS_AGENCIA, AGENTE), matriz('agency', 'admin'));
  });

  test('con cuenta y sin membresía: ninguno, no un rol por omisión', async () => {
    assert.deepEqual(await misPermisos(WORKSPACE_LAURA, NADIE), []);
  });

  test('desde otro workspace la misma persona no es nadie (aislamiento)', async () => {
    assert.deepEqual(await misPermisos(WS_AGENCIA, LAURA), []);
    assert.deepEqual(await misPermisos(WS_AGENCIA, CONTADORA), []);
    assert.deepEqual(await misPermisos(WORKSPACE_LAURA, AGENTE), []);
  });

  test('sin identidad fijada (modo demo) no hay permisos que leer', async () => {
    assert.deepEqual(await misPermisos(WORKSPACE_LAURA), []);
  });

  test('la consulta no recibe ids: los lee de la transacción', () => {
    assert.equal(getSessionPermissions.length, 1);
  });
});
