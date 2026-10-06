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

describe('cambiar el rol, las casillas y quitar', () => {
  test('la dueña marca y desmarca la casilla de finanzas del mánager, con su bitácora', async () => {
    const manager = await rol('creator', 'manager');
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, ANDRES, manager, CASILLAS.finanzas)), { ok: true, changed: true });
    assert.ok((await en(WORKSPACE_LAURA, ANDRES, (tx) => getSessionPermissions(tx))).includes('finanzas.flujo.ver'));
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, ANDRES, manager, [])), { ok: true, changed: true });
    assert.ok(!(await en(WORKSPACE_LAURA, ANDRES, (tx) => getSessionPermissions(tx))).includes('finanzas.flujo.ver'));
    // Sin cambios no escribe ni anota.
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, ANDRES, manager, [])), { ok: true, changed: false });
    assert.deepEqual(await bitacora(ANDRES), ['membership.role_changed', 'membership.role_changed']);
  });

  test('la casilla de conectar cuentas es lo que ACC-8 pregunta (sessionHasPermission)', async () => {
    const manager = await rol('creator', 'manager');
    await comoLaura((tx) => changeMemberRole(tx, BEATRIZ, manager, [...CASILLAS.finanzas, ...CASILLAS.conexiones]));
    assert.equal(await en(WORKSPACE_LAURA, BEATRIZ, (tx) => sessionHasPermission(tx, 'conexiones.cuenta.conectar')), true);
  });

  test('las casillas solo van con el Mánager de creador', async () => {
    const editor = await rol('creator', 'editor');
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, CAMILO, editor, CASILLAS.finanzas)), {
      ok: false,
      code: 'extras_not_allowed',
    });
  });

  test('el mánager no cambia roles ni quita a nadie: ni por la consulta ni escribiendo a mano', async () => {
    const viewer = await rol('creator', 'viewer');
    assert.deepEqual(await en(WORKSPACE_LAURA, ANDRES, (tx) => changeMemberRole(tx, CAMILO, viewer, [])), { ok: false, code: 'forbidden' });
    assert.deepEqual(await en(WORKSPACE_LAURA, ANDRES, (tx) => removeMember(tx, CAMILO)), { ok: false, code: 'forbidden' });
    // A mano: la política no deja ver la fila para cambiarla ni para borrarla.
    const cambio = await en(WORKSPACE_LAURA, ANDRES, (tx) =>
      tx.query(`UPDATE membership SET role_id = system_role_id('creator', 'owner') WHERE user_id = '${ANDRES}'`),
    );
    assert.equal(cambio.rowCount ?? cambio.rows.length, 0);
    const baja = await en(WORKSPACE_LAURA, ANDRES, (tx) => tx.query(`DELETE FROM membership WHERE user_id = '${CAMILO}'`));
    assert.equal(baja.rowCount ?? baja.rows.length, 0);
    // Y sigue siendo Mánager.
    const yo = (await comoLaura((tx) => listMembers(tx))).find((m) => m.userId === ANDRES);
    assert.equal(yo?.roleKey, 'manager');
  });

  test('el mánager no invita: ni por la consulta ni escribiendo a mano', async () => {
    const viewer = await rol('creator', 'viewer');
    const token = newInvitationToken();
    const input = { email: 'otro@ejemplo.test', roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token };
    assert.deepEqual(await en(WORKSPACE_LAURA, ANDRES, (tx) => createInvitation(tx, input)), { ok: false, code: 'forbidden' });
    await assert.rejects(
      en(WORKSPACE_LAURA, ANDRES, (tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at)
           VALUES (current_workspace_id(), 'otro@ejemplo.test', $1, $2, current_user_id(), now() + interval '1 day')`,
          [viewer, invitationTokenHash(token)],
        ),
      ),
      (err) => /row-level security/i.test(mensajes(err)),
    );
  });

  test('una invitación no se edita: solo se revoca, y una revocada no se reabre', async () => {
    const { invitationId } = await invitar('editable@ejemplo.test', 'viewer');
    const owner = await rol('creator', 'owner');
    await assert.rejects(
      comoLaura((tx) => tx.query(`UPDATE invitation SET role_id = $1 WHERE id = $2`, [owner, invitationId])),
      (err) => /permission denied/i.test(mensajes(err)),
    );
    await comoLaura((tx) => revokeInvitation(tx, invitationId));
    await assert.rejects(
      comoLaura((tx) => tx.query(`UPDATE invitation SET revoked_at = NULL WHERE id = $1`, [invitationId])),
      (err) => /ya no está pendiente/.test(mensajes(err)),
    );
  });

  test('invitar otra vez al mismo correo revoca la pendiente: el enlace viejo deja de servir', async () => {
    const primera = await invitar('dos-veces@ejemplo.test', 'viewer');
    const segunda = await invitar('dos-veces@ejemplo.test', 'editor');
    const pendientes = (await comoLaura((tx) => listPendingInvitations(tx))).filter((i) => i.email === 'dos-veces@ejemplo.test');
    assert.deepEqual(pendientes.map((i) => [i.id, i.roleKey]), [[segunda.invitationId, 'editor']]);
    const vista = await t.db.withIdentity({ userId: CAMILO }, (tx) => lookupInvitation(tx, primera.token));
    assert.deepEqual(vista, { status: 'revoked' });
  });

  test('no se invita a quien ya está', async () => {
    const viewer = await rol('creator', 'viewer');
    const input = { email: CORREO[ANDRES], roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
    assert.deepEqual(await comoLaura((tx) => createInvitation(tx, input)), { ok: false, code: 'already_member' });
  });

  test('la dueña quita a alguien: sale de la lista, pierde sus permisos y queda en la bitácora', async () => {
    assert.deepEqual(await comoLaura((tx) => removeMember(tx, CAMILO)), { ok: true });
    assert.ok(!(await comoLaura((tx) => listMembers(tx))).some((m) => m.userId === CAMILO));
    assert.deepEqual(await en(WORKSPACE_LAURA, CAMILO, (tx) => getSessionPermissions(tx)), []);
    assert.deepEqual(await bitacora(CAMILO), ['membership.removed']);
  });
});

describe('el último dueño', () => {
  test('quitar a la única dueña falla con mensaje, y no quita nada', async () => {
    await assert.rejects(comoLaura((tx) => removeMember(tx, LAURA)), (err) => {
      assert.ok(err instanceof UltimoDuenoError);
      assert.match(err.message, /último dueño/);
      return true;
    });
    assert.ok((await comoLaura((tx) => listMembers(tx))).some((m) => m.userId === LAURA && m.roleKey === 'owner'));
  });

  test('degradarla tampoco', async () => {
    const manager = await rol('creator', 'manager');
    await assert.rejects(comoLaura((tx) => changeMemberRole(tx, LAURA, manager, [])), UltimoDuenoError);
  });

  test('la base lo para aunque se escriba a mano (membership_keeps_an_owner)', async () => {
    await assert.rejects(
      comoLaura((tx) => tx.query(`DELETE FROM membership WHERE user_id = '${LAURA}'`)),
      (err) => {
        let e: unknown = err;
        while (e instanceof Error && !isLastOwnerError(e) && e.cause) e = e.cause;
        assert.ok(isLastOwnerError(e), mensajes(err));
        return true;
      },
    );
  });

  test('con otra dueña, sí: Daniela pasa a Dueña y Laura puede bajar a Mánager y volver', async () => {
    const owner = await rol('creator', 'owner');
    const manager = await rol('creator', 'manager');
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, DANIELA, owner, [])), { ok: true, changed: true });
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, LAURA, manager, [])), { ok: true, changed: true });
    // Ahora la única dueña es Daniela, y Laura (Mánager) ya no puede tocar roles.
    await assert.rejects(en(WORKSPACE_LAURA, DANIELA, (tx) => removeMember(tx, DANIELA)), UltimoDuenoError);
    assert.deepEqual(await en(WORKSPACE_LAURA, DANIELA, (tx) => changeMemberRole(tx, LAURA, owner, [])), { ok: true, changed: true });
    assert.deepEqual(await comoLaura((tx) => removeMember(tx, DANIELA)), { ok: true });
  });
});

describe('nadie otorga lo que no tiene ni toca a quien tiene más', () => {
  const comoAdmin = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS_AGENCIA, ADMIN_AGENCIA, fn);

  test('una Administradora de agencia no invita a nadie como Dueño', async () => {
    const owner = await rol('agency', 'owner');
    const token = newInvitationToken();
    const input = { email: 'socio@agencia.test', roleId: owner, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token };
    assert.deepEqual(await comoAdmin((tx) => createInvitation(tx, input)), { ok: false, code: 'cannot_grant' });
    await assert.rejects(
      comoAdmin((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at)
           VALUES (current_workspace_id(), 'socio@agencia.test', $1, $2, current_user_id(), now() + interval '1 day')`,
          [owner, invitationTokenHash(token)],
        ),
      ),
      (err) => /row-level security/i.test(mensajes(err)),
    );
  });

  test('ni se hace Dueña a sí misma, ni degrada a la Dueña', async () => {
    const owner = await rol('agency', 'owner');
    const viewer = await rol('agency', 'viewer');
    assert.deepEqual(await comoAdmin((tx) => changeMemberRole(tx, ADMIN_AGENCIA, owner, [])), { ok: false, code: 'cannot_grant' });
    assert.deepEqual(await comoAdmin((tx) => changeMemberRole(tx, DUENA_AGENCIA, viewer, [])), { ok: false, code: 'cannot_grant' });
    assert.deepEqual(await comoAdmin((tx) => removeMember(tx, DUENA_AGENCIA)), { ok: false, code: 'cannot_grant' });
    await assert.rejects(
      comoAdmin((tx) => tx.query(`UPDATE membership SET role_id = $1 WHERE user_id = '${ADMIN_AGENCIA}'`, [owner])),
      (err) => /row-level security/i.test(mensajes(err)),
    );
    const degradar = await comoAdmin((tx) =>
      tx.query(`UPDATE membership SET role_id = $1 WHERE user_id = '${DUENA_AGENCIA}'`, [viewer]),
    );
    assert.equal(degradar.rowCount ?? degradar.rows.length, 0);
  });

  test('pero sí invita a lo que tiene: un Ejecutivo de cuenta', async () => {
    const manager = await rol('agency', 'manager');
    const input = { email: 'ejecutivo@agencia.test', roleId: manager, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
    assert.equal((await comoAdmin((tx) => createInvitation(tx, input))).ok, true);
  });
});

describe('0078: las casillas en la base y el archivo dos veces', () => {
  test('el CHECK de las casillas es exactamente EXTRA_PERMISOS de @mc/core', async () => {
    const filas = await comoLaura((tx) =>
      tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname IN ('membership_extra_permissions_allowed', 'invitation_extra_permissions_allowed')`,
      ),
    );
    assert.equal(filas.rows.length, 2);
    for (const { def } of filas.rows) {
      const enLaBase = [...def.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]);
      assert.deepEqual(enLaBase, [...EXTRA_PERMISOS]);
    }
  });

  test('aplicarla otra vez como el rol que migra no falla ni cambia nada', async () => {
    const sql = readFileSync(fileURLToPath(new URL('../../../db/migrations/0078_equipo.sql', import.meta.url)), 'utf8');
    const foto = () =>
      comoLaura((tx) =>
        tx.query(
          `SELECT (SELECT count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                    WHERE c.relname IN ('membership', 'invitation')) AS politicas,
                  (SELECT count(*)::int FROM membership) AS miembros,
                  (SELECT count(*)::int FROM invitation) AS invitaciones`,
        ),
      );
    const antes = await foto();
    await t.admin(`SET ROLE ${migratorRole(t)};\n${sql}\nRESET ROLE;`);
    assert.deepEqual((await foto()).rows, antes.rows);
  });
});
