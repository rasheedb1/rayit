/**
 * ACC-4 · Equipo contra Postgres embebido con el seed, como mc_app y con
 * personas de verdad (identidad fijada, sin la bandera de la demo):
 *
 *   - un creador invita a su mánager, el mánager acepta por el enlace y
 *     tiene Campañas pero no el flujo de caja; con la casilla de
 *     finanzas, sí (terminado cuando);
 *   - un enlace usado, vencido, revocado o de otro correo no sirve;
 *   - quitar o degradar al último dueño falla, en la consulta y en la
 *     base aunque se escriba a mano;
 *   - nadie otorga lo que no tiene ni toca a quien tiene más, en la
 *     consulta y en la base (políticas de 0078);
 *   - todo deja su fila en audit_log;
 *   - el CHECK de las casillas es la lista de @mc/core, y 0078 se puede
 *     aplicar dos veces.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASILLAS, EXTRA_PERMISOS, UltimoDuenoError } from '@mc/core';
import type { WorkspaceTx } from '../src/client.ts';
import { getSessionPermissions } from '../src/queries/accesos.ts';
import { sessionHasPermission } from '../src/queries/conexiones.ts';
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  invitationTokenHash,
  isLastOwnerError,
  listMembers,
  listPendingInvitations,
  listTeamRoles,
  lookupInvitation,
  newInvitationToken,
  removeMember,
  revokeInvitation,
} from '../src/queries/equipo.ts';
import { migratorRole, openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = '00000002-0000-4000-8000-000000000002';
/** Personas de esta prueba, con cuenta y sin espacio. */
const ANDRES = '00000078-0000-4000-8000-0000000000a1';
const BEATRIZ = '00000078-0000-4000-8000-0000000000b1';
const CAMILO = '00000078-0000-4000-8000-0000000000c1';
const DANIELA = '00000078-0000-4000-8000-0000000000d1';
/** Una agencia con su dueña y una administradora. */
const WS_AGENCIA = '00000078-0000-4000-8000-00000000a9e0';
const DUENA_AGENCIA = '00000078-0000-4000-8000-0000000000e1';
const ADMIN_AGENCIA = '00000078-0000-4000-8000-0000000000e2';

const CORREO = {
  [ANDRES]: 'andres@ejemplo.test',
  [BEATRIZ]: 'beatriz@ejemplo.test',
  [CAMILO]: 'camilo@ejemplo.test',
  [DANIELA]: 'daniela@ejemplo.test',
} as const;

const EN_UNA_SEMANA = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

let t: TestDb;

before(async () => {
  t = await openTestDb({ authDisabled: false });
  await t.admin(`
    INSERT INTO app_user (id, email, name) VALUES
      ('${ANDRES}', '${CORREO[ANDRES]}', 'Andrés Mánager'),
      ('${BEATRIZ}', '${CORREO[BEATRIZ]}', 'Beatriz Mánager'),
      ('${CAMILO}', '${CORREO[CAMILO]}', 'Camilo Curioso'),
      ('${DANIELA}', '${CORREO[DANIELA]}', 'Daniela Dueña'),
      ('${DUENA_AGENCIA}', 'duena@agencia.test', 'Dueña Agencia'),
      ('${ADMIN_AGENCIA}', 'admin@agencia.test', 'Admin Agencia');
    SELECT set_config('app.workspace_id', '${WS_AGENCIA}', false);
    INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_AGENCIA}', 'agencia-acc4', 'Agencia ACC-4', 'agency');
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES
      ('${WS_AGENCIA}', '${DUENA_AGENCIA}', system_role_id('agency', 'owner')),
      ('${WS_AGENCIA}', '${ADMIN_AGENCIA}', system_role_id('agency', 'admin'));
    SELECT set_config('app.workspace_id', '', false);
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

/** Una transacción en el espacio de Laura, como `userId`. */
const en = <T>(ws: string, userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(ws, fn, { userId });
const comoLaura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WORKSPACE_LAURA, LAURA, fn);

/** El id de un rol de sistema. */
async function rol(kind: 'creator' | 'agency', key: string): Promise<string> {
  const ws = kind === 'creator' ? WORKSPACE_LAURA : WS_AGENCIA;
  const quien = kind === 'creator' ? LAURA : DUENA_AGENCIA;
  const roles = await en(ws, quien, (tx) => listTeamRoles(tx));
  const r = roles.find((x) => x.key === key && x.isSystem);
  assert.ok(r, `no hay rol ${kind}/${key}`);
  return r.id;
}

/** Laura invita y devuelve el token del enlace. */
async function invitar(email: string, key: string, extras: readonly string[] = [], expiresAt = EN_UNA_SEMANA()) {
  const token = newInvitationToken();
  const roleId = await rol('creator', key);
  const r = await comoLaura((tx) => createInvitation(tx, { email, roleId, extraPermissions: extras, expiresAt, token }));
  assert.ok(r.ok, `la invitación no se creó: ${JSON.stringify(r)}`);
  return { token, invitationId: r.invitationId };
}

const aceptarComo = (userId: string, token: string) =>
  t.db.withIdentity({ userId }, (tx) => acceptInvitation(tx, token));

/** Las acciones de bitácora de una entidad, en orden. */
async function bitacora(entityId: string): Promise<string[]> {
  const filas = await comoLaura((tx) =>
    tx.query<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = $1::uuid ORDER BY created_at, action', [entityId]),
  );
  return filas.rows.map((f) => f.action);
}

/** Drizzle y pg envuelven el error; el motivo real va en `cause`. */
function mensajes(err: unknown): string {
  const partes: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return partes.join(' ← ');
}

describe('el creador invita a su mánager (terminado cuando)', () => {
  test('el enlace dice a qué espacio y con qué rol, y el mánager entra: Campañas sí, flujo de caja no', async () => {
    const { token, invitationId } = await invitar(CORREO[ANDRES], 'manager');

    const vista = await t.db.withIdentity({ userId: ANDRES }, (tx) => lookupInvitation(tx, token));
    assert.equal(vista.status, 'pending');
    assert.ok(vista.status === 'pending');
    assert.equal(vista.roleKey, 'manager');
    assert.equal(vista.roleLabel, 'Mánager');
    assert.equal(vista.emailMatches, true);
    assert.equal(vista.invitedEmailMasked, 'a•••@ejemplo.test');
    assert.deepEqual(vista.extraPermissions, []);

    assert.deepEqual(await aceptarComo(ANDRES, token), { status: 'ok', workspaceId: WORKSPACE_LAURA, roleKey: 'manager' });

    const permisos = await en(WORKSPACE_LAURA, ANDRES, (tx) => getSessionPermissions(tx));
    assert.ok(permisos.includes('campanas.campana.ver'));
    assert.ok(!permisos.includes('finanzas.flujo.ver'));
    assert.ok(!permisos.includes('finanzas.factura.ver'));
    assert.equal(await en(WORKSPACE_LAURA, ANDRES, (tx) => sessionHasPermission(tx, 'conexiones.cuenta.conectar')), false);

    assert.deepEqual(await bitacora(invitationId), ['invitation.created', 'invitation.accepted']);
  });

  test('con la casilla de finanzas marcada, el mánager sí ve el flujo de caja', async () => {
    const { token } = await invitar(CORREO[BEATRIZ], 'manager', CASILLAS.finanzas);
    assert.equal((await aceptarComo(BEATRIZ, token)).status, 'ok');
    const permisos = await en(WORKSPACE_LAURA, BEATRIZ, (tx) => getSessionPermissions(tx));
    for (const p of CASILLAS.finanzas) assert.ok(permisos.includes(p), p);
    assert.ok(!permisos.includes('finanzas.factura.crear'), 'ver finanzas no es operar finanzas');
    assert.ok(!permisos.includes('conexiones.cuenta.conectar'));
  });

  test('un enlace usado no sirve otra vez, ni para quien lo usó', async () => {
    const { token } = await invitar(CORREO[CAMILO], 'viewer');
    assert.equal((await aceptarComo(CAMILO, token)).status, 'ok');
    assert.deepEqual(await aceptarComo(CAMILO, token), { status: 'used' });
    const vista = await t.db.withIdentity({ userId: CAMILO }, (tx) => lookupInvitation(tx, token));
    assert.deepEqual(vista, { status: 'used' });
  });

  test('un enlace vencido no sirve y no da de alta a nadie', async () => {
    const { token } = await invitar(CORREO[DANIELA], 'editor', [], new Date(Date.now() - 60_000));
    assert.deepEqual(await aceptarComo(DANIELA, token), { status: 'expired' });
    const miembros = await comoLaura((tx) => listMembers(tx));
    assert.ok(!miembros.some((m) => m.userId === DANIELA));
  });

  test('un enlace revocado no sirve', async () => {
    const { token, invitationId } = await invitar(CORREO[DANIELA], 'editor');
    assert.deepEqual(await comoLaura((tx) => revokeInvitation(tx, invitationId)), { ok: true });
    assert.deepEqual(await aceptarComo(DANIELA, token), { status: 'revoked' });
    assert.deepEqual(await bitacora(invitationId), ['invitation.created', 'invitation.revoked']);
  });

  test('el enlace reenviado a otra persona no le sirve, y no se gasta', async () => {
    const { token } = await invitar(CORREO[DANIELA], 'editor');
    const vista = await t.db.withIdentity({ userId: CAMILO }, (tx) => lookupInvitation(tx, token));
    assert.ok(vista.status === 'pending' && vista.emailMatches === false);
    assert.deepEqual(await aceptarComo(CAMILO, token), { status: 'wrong_email' });
    assert.equal((await aceptarComo(DANIELA, token)).status, 'ok');
  });

  test('un token inventado o cortado no llega a la base', async () => {
    assert.deepEqual(await aceptarComo(CAMILO, 'no-es-un-token'), { status: 'not_found' });
    assert.deepEqual(await aceptarComo(CAMILO, newInvitationToken()), { status: 'not_found' });
  });

  test('sin sesión no se acepta nada', async () => {
    const { token } = await invitar('nadie@ejemplo.test', 'viewer');
    await assert.rejects(
      t.db.withIdentity({ email: 'nadie@ejemplo.test' }, (tx) => acceptInvitation(tx, token)),
      (err) => /necesita una sesión/.test(mensajes(err)),
    );
  });
});
