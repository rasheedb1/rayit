/**
 * ACC-5: «qué puedo hacer en este espacio» sale de mi membresía en el
 * workspace de la transacción, y de nada más.
 *
 * Corre como mc_app sobre Postgres embebido con el seed: la dueña del
 * seed es owner en su espacio; una persona con membresía `viewer`
 * (insertada aquí, porque el seed no trae un segundo usuario) recibe
 * `viewer`; quien no es miembro, null; la misma persona desde OTRO
 * workspace, null (RLS y la condición por workspace); y sin identidad
 * fijada —el modo demo— null: nadie recibe permisos por omisión.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getSessionMembership } from '../src/queries/accesos.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = '00000002-0000-4000-8000-000000000002';
/** Una persona nueva, con membresía de solo lectura en el espacio de Laura. */
const VALERIA = '0000000e-0000-4000-8000-000000000001';
/** Alguien con cuenta pero sin membresía en ningún espacio. */
const NADIE = '0000000e-0000-4000-8000-000000000002';
/** Un segundo espacio, de agencia, donde Laura no es nadie. */
const WS_AGENCIA = '0000000e-0000-4000-8000-0000000000a1';
/** Su dueño. */
const AGENTE = '0000000e-0000-4000-8000-000000000003';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO app_user (id, email, name) VALUES
      ('${VALERIA}', 'valeria@ejemplo.test', 'Valeria Ruiz'),
      ('${NADIE}', 'nadie@ejemplo.test', 'Sin Espacio'),
      ('${AGENTE}', 'agente@ejemplo.test', 'Agente Uno');
    INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_AGENCIA}', 'agencia-uno', 'Agencia Uno', 'agency');
    SELECT set_config('app.workspace_id', '${WORKSPACE_LAURA}', false);
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_LAURA}', '${VALERIA}', 'viewer');
    SELECT set_config('app.workspace_id', '${WS_AGENCIA}', false);
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_AGENCIA}', '${AGENTE}', 'admin');
    SELECT set_config('app.workspace_id', '', false);
  `);
}, { timeout: 120_000 });

after(async () => {
  await t?.close();
});

const miMembresia = (ws: string, userId?: string) =>
  t.db.withWorkspace(ws, (tx) => getSessionMembership(tx), userId ? { userId } : undefined);

describe('getSessionMembership', () => {
  test('la dueña del seed es owner en su espacio, que es de creador', async () => {
    assert.deepEqual(await miMembresia(WORKSPACE_LAURA, LAURA), { role: 'owner', workspaceKind: 'creator' });
  });

  test('una membresía de solo lectura vuelve como viewer, no como lo que tenga el seed', async () => {
    assert.deepEqual(await miMembresia(WORKSPACE_LAURA, VALERIA), { role: 'viewer', workspaceKind: 'creator' });
  });

  test('el tipo del workspace viene de la fila workspace: agencia para el administrador de la agencia', async () => {
    assert.deepEqual(await miMembresia(WS_AGENCIA, AGENTE), { role: 'admin', workspaceKind: 'agency' });
  });

  test('con cuenta y sin membresía: null, no un rol por omisión', async () => {
    assert.equal(await miMembresia(WORKSPACE_LAURA, NADIE), null);
  });

  test('desde otro workspace la misma persona no es nadie (aislamiento)', async () => {
    assert.equal(await miMembresia(WS_AGENCIA, LAURA), null);
    assert.equal(await miMembresia(WS_AGENCIA, VALERIA), null);
    assert.equal(await miMembresia(WORKSPACE_LAURA, AGENTE), null);
  });

  test('sin identidad fijada (modo demo) no hay membresía que leer', async () => {
    assert.equal(await miMembresia(WORKSPACE_LAURA), null);
  });

  test('ningún id de persona ni de espacio se pasa por parámetro: la consulta lee los dos de la transacción', async () => {
    // Si alguien cambiara la firma para recibir ids, esto deja de compilar
    // (getSessionMembership.length) y de paso queda escrito por qué.
    assert.equal(getSessionMembership.length, 1);
  });
});
