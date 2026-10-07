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
 *   - quien tiene alcance (ACC-6) no administra el equipo, y una
 *     invitación no lleva alcance (0079 §6);
 *   - el rol tiene que ser del tipo del espacio, también a mano (lo
 *     exige 0034 §5; 0079 no lo toca);
 *   - como mucho INVITACIONES_POR_DIA invitaciones por espacio en 24
 *     horas, y una fecha vieja no se cuela (0079 §7);
 *   - sin equipo.miembro.ver no se leen las invitaciones (0080 §1);
 *   - si degradan o quitan a quien invitó, su enlace deja de servir y
 *     la invitación sale de pendientes (0080 §2 y §3);
 *   - el CHECK de las casillas es la lista de @mc/core, y 0078, 0079 y
 *     0080 se pueden aplicar dos veces.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASILLAS, EXTRA_PERMISOS, INVITACIONES_POR_DIA, UltimoDuenoError } from '@mc/core';
import type { WorkspaceTx } from '../src/client.ts';
import { getSessionPermissions } from '../src/queries/accesos.ts';
import { sessionHasPermission } from '../src/queries/conexiones.ts';
import {
  acceptInvitation,
  aResultadoDeAceptar,
  aVistaDeInvitacion,
  changeMemberRole,
  createInvitation,
  hasPendingInvitationForSessionEmail,
  invitationTokenHash,
  isFullRoleUnscopedError,
  isLastOwnerError,
  listMembers,
  listPendingInvitations,
  listTeamRoles,
  lookupInvitation,
  newInvitationToken,
  removeMember,
  revokeInvitation,
  sessionHasScope,
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
      tx.query(`UPDATE membership SET role_id = system_role_id('creator', 'owner') WHERE user_id = '${ANDRES}' RETURNING user_id`),
    );
    assert.equal(cambio.rows.length, 0);
    const baja = await en(WORKSPACE_LAURA, ANDRES, (tx) => tx.query(`DELETE FROM membership WHERE user_id = '${CAMILO}' RETURNING user_id`));
    assert.equal(baja.rows.length, 0);
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
      tx.query(`UPDATE membership SET role_id = $1 WHERE user_id = '${DUENA_AGENCIA}' RETURNING user_id`, [viewer]),
    );
    assert.equal(degradar.rows.length, 0);
  });

  test('pero sí invita a lo que tiene: un Ejecutivo de cuenta', async () => {
    const manager = await rol('agency', 'manager');
    const input = { email: 'ejecutivo@agencia.test', roleId: manager, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
    assert.equal((await comoAdmin((tx) => createInvitation(tx, input))).ok, true);
  });

  test('ni revoca la invitación de Dueño que hizo la Dueña: ni directo, ni invitando de nuevo con menos, ni a mano (0079 §2)', async () => {
    const owner = await rol('agency', 'owner');
    const viewer = await rol('agency', 'viewer');
    const correo = 'socia@agencia.test';
    const deLaDuena = await en(WS_AGENCIA, DUENA_AGENCIA, (tx) =>
      createInvitation(tx, { email: correo, roleId: owner, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() }),
    );
    assert.ok(deLaDuena.ok);

    assert.deepEqual(await comoAdmin((tx) => revokeInvitation(tx, deLaDuena.invitationId)), { ok: false, code: 'cannot_grant' });
    const reemplazo = { email: correo, roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
    assert.deepEqual(await comoAdmin((tx) => createInvitation(tx, reemplazo)), { ok: false, code: 'cannot_grant' });
    const aMano = await comoAdmin((tx) =>
      tx.query('UPDATE invitation SET revoked_at = now() WHERE id = $1 RETURNING id', [deLaDuena.invitationId]),
    );
    assert.equal(aMano.rows.length, 0);

    const pendientes = await en(WS_AGENCIA, DUENA_AGENCIA, (tx) => listPendingInvitations(tx));
    assert.ok(pendientes.some((i) => i.id === deLaDuena.invitationId), 'la invitación de Dueño sigue pendiente');
    // La Dueña sí la revoca.
    assert.deepEqual(await en(WS_AGENCIA, DUENA_AGENCIA, (tx) => revokeInvitation(tx, deLaDuena.invitationId)), { ok: true });
  });
});

describe('lo que devuelve invitation_lookup se comprueba, no se cree', () => {
  const pendiente = {
    status: 'pending', workspaceName: 'Laura', roleKey: 'manager', roleLabel: 'Mánager', extraPermissions: [],
    expiresAt: '2026-10-12T00:00:00Z', invitedByName: null, invitedEmailMasked: 'a•••@x.test', emailMatches: true,
  };

  test('una pendiente bien formada pasa, con la fecha en ISO', () => {
    const v = aVistaDeInvitacion(pendiente);
    assert.equal(v.status, 'pending');
    assert.ok(v.status === 'pending' && v.expiresAt === '2026-10-12T00:00:00.000Z');
  });

  test('un estado cerrado pasa tal cual; cualquier otra cosa es not_found', () => {
    assert.deepEqual(aVistaDeInvitacion({ status: 'used' }), { status: 'used' });
    for (const raro of [null, 'pending', { status: 'otro' }, { ...pendiente, roleLabel: 3 }, { ...pendiente, expiresAt: 'nunca' },
      { ...pendiente, extraPermissions: [1] }, { ...pendiente, emailMatches: 'sí' }]) {
      assert.deepEqual(aVistaDeInvitacion(raro), { status: 'not_found' }, JSON.stringify(raro));
    }
  });

  test('aceptar: ok con su uuid y su rol, o un estado que la pantalla sabe decir; lo demás es not_found', () => {
    const ok = { status: 'ok', workspaceId: WORKSPACE_LAURA, roleKey: 'manager' };
    assert.deepEqual(aResultadoDeAceptar(ok), ok);
    assert.deepEqual(aResultadoDeAceptar({ ...ok, extra: 1 }), ok, 'las claves de más no viajan');
    for (const cerrado of ['not_found', 'revoked', 'used', 'expired', 'wrong_email', 'already_member'] as const) {
      assert.deepEqual(aResultadoDeAceptar({ status: cerrado }), { status: cerrado });
    }
    for (const raro of [null, undefined, 'ok', { status: 'otro' }, { status: 'pending' }, { ...ok, workspaceId: 'no-uuid' },
      { ...ok, workspaceId: 7 }, { ...ok, roleKey: '' }, { ...ok, roleKey: null }, { status: 'ok' }]) {
      assert.deepEqual(aResultadoDeAceptar(raro), { status: 'not_found' }, JSON.stringify(raro));
    }
  });
});

describe('dos personas invitan al mismo correo a la vez', () => {
  test('la segunda recibe pending_exists, no un 23505, y su transacción sigue viva', async () => {
    const primera = await invitar('carrera@ejemplo.test', 'viewer');
    const viewer = await rol('creator', 'viewer');
    // La carrera, sin dos conexiones: la segunda no ve la pendiente al
    // revocar (como si la primera aún no hubiera confirmado) y choca en
    // el INSERT contra invitation_pending_uk.
    const r = await comoLaura(async (tx) => {
      const query = ((text: string, params?: readonly unknown[]) =>
        /^\s*UPDATE invitation SET revoked_at/.test(text)
          ? Promise.resolve({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] })
          : tx.query(text, params)) as WorkspaceTx['query'];
      const ciega = new Proxy(tx, { get: (obj, k) => (k === 'query' ? query : Reflect.get(obj, k)) });
      const res = await createInvitation(ciega, {
        email: 'carrera@ejemplo.test', roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken(),
      });
      const viva = await tx.query<{ uno: number }>('SELECT 1 AS uno');
      return { res, viva: viva.rows[0]?.uno };
    });
    assert.deepEqual(r, { res: { ok: false, code: 'pending_exists' }, viva: 1 });
    const pendientes = (await comoLaura((tx) => listPendingInvitations(tx))).filter((i) => i.email === 'carrera@ejemplo.test');
    assert.deepEqual(pendientes.map((i) => i.id), [primera.invitationId]);
  });
});

describe('¿me esperan en algún espacio? (0079 §1)', () => {
  const pregunta = (email: string) => t.db.withIdentity({ email }, (tx) => hasPendingInvitationForSessionEmail(tx));

  test('sí con una pendiente y vigente; no vencida, revocada, aceptada, ni sin correo', async () => {
    await invitar('esperada@ejemplo.test', 'manager');
    assert.equal(await pregunta('esperada@ejemplo.test'), true);
    assert.equal(await pregunta('ESPERADA@ejemplo.test'), true, 'citext: sin distinguir mayúsculas');
    assert.equal(await pregunta('nadie-me-espera@ejemplo.test'), false);

    await invitar('vencida-0079@ejemplo.test', 'viewer', [], new Date(Date.now() - 60_000));
    assert.equal(await pregunta('vencida-0079@ejemplo.test'), false);

    const revocada = await invitar('revocada-0079@ejemplo.test', 'viewer');
    await comoLaura((tx) => revokeInvitation(tx, revocada.invitationId));
    assert.equal(await pregunta('revocada-0079@ejemplo.test'), false);

    // Andrés aceptó la suya al principio: ya no lo esperan.
    assert.equal(await pregunta(CORREO[ANDRES]), false);

    assert.equal(await t.db.withIdentity({ userId: CAMILO }, (tx) => hasPendingInvitationForSessionEmail(tx)), false);
  });

  test('mc_app no lee invitaciones ajenas fijando la bandera a mano', async () => {
    const filas = await t.db.withIdentity({ email: 'esperada@ejemplo.test' }, async (tx) => {
      await tx.query("SELECT set_config('app.invitation_email_probe', 'on', true)");
      return (await tx.query('SELECT id FROM invitation')).rows;
    });
    assert.equal(filas.length, 0);
  });
});

describe('el último dueño, sin la excepción por cascada (0079 §3)', () => {
  const WS_SOLA = '00000079-0000-4000-8000-00000000a501';
  const SOLA = '00000079-0000-4000-8000-0000000000f1';

  test('borrar a la persona que es la única dueña de un espacio vivo falla; borrar el espacio entero, no', async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${SOLA}', 'sola@ejemplo.test', 'Sola');
      SELECT set_config('app.workspace_id', '${WS_SOLA}', false);
      INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_SOLA}', 'sola-0079', 'Sola 0079', 'creator');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_SOLA}', '${SOLA}', system_role_id('creator', 'owner'));
      SELECT set_config('app.workspace_id', '', false);
    `);
    await assert.rejects(t.admin(`DELETE FROM app_user WHERE id = '${SOLA}'`), (err) => /último dueño/.test(mensajes(err)));
    await t.admin(`DELETE FROM workspace WHERE id = '${WS_SOLA}'; DELETE FROM app_user WHERE id = '${SOLA}';`);
  });
});

describe('las casillas solo con el Mánager de creador, también en la base (0079 §4)', () => {
  test('ni a mano en una membresía de Editor ni en una invitación de Editor', async () => {
    const editor = await rol('creator', 'editor');
    await comoLaura((tx) => changeMemberRole(tx, BEATRIZ, editor, []));
    await assert.rejects(
      comoLaura((tx) => tx.query(`UPDATE membership SET extra_permissions = $1 WHERE user_id = '${BEATRIZ}'`, [CASILLAS.finanzas])),
      (err) => /solo van con el rol de Mánager/.test(mensajes(err)),
    );
    await assert.rejects(
      comoLaura((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, extra_permissions, token_hash, invited_by, expires_at)
           VALUES (current_workspace_id(), 'casillas@ejemplo.test', $1, $2, $3, current_user_id(), now() + interval '1 day')`,
          [editor, CASILLAS.finanzas, invitationTokenHash(newInvitationToken())],
        ),
      ),
      (err) => /solo van con el rol de Mánager/.test(mensajes(err)),
    );
  });

  test('con el Mánager, sí', async () => {
    const manager = await rol('creator', 'manager');
    assert.deepEqual(await comoLaura((tx) => changeMemberRole(tx, BEATRIZ, manager, CASILLAS.conexiones)), { ok: true, changed: true });
  });
});

describe('0078, 0079 y 0080: las casillas en la base y los archivos dos veces', () => {
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

  test('aplicar 0078, 0079 y 0080 otra vez, en orden, como el rol que migra no falla ni cambia nada', async () => {
    const leer = (f: string) => readFileSync(fileURLToPath(new URL(`../../../db/migrations/${f}`, import.meta.url)), 'utf8');
    const sql = ['0078_equipo.sql', '0079_equipo_cerrojos.sql', '0080_equipo_quien_invito.sql'].map(leer).join('\n');
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

describe('quien tiene alcance no administra el equipo (0079 §6)', () => {
  /**
   * Una Coordinadora con un rol a medida que tiene los permisos de la
   * Administradora: Dueño y Administrador no pueden llevar alcance (0082
   * §2, ACC-7), así que quien administra el equipo Y tiene alcance solo
   * puede ser un rol a medida.
   */
  const COORDINADORA = '00000079-0000-4000-8000-0000000000c7';
  const comoAdmin = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS_AGENCIA, COORDINADORA, fn);
  /** Una creadora cualquiera: el alcance solo pide un uuid, la clave foránea es a la membresía. */
  const CREADORA = '00000079-0000-4000-8000-00000000c0de';

  test('con una fila de alcance, quien administra el equipo no invita, ni cambia, ni quita, ni revoca: ni por la consulta ni a mano', async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${COORDINADORA}', 'coordinadora@agencia.test', 'Coordinadora') ON CONFLICT DO NOTHING;
      INSERT INTO role (workspace_id, key, workspace_kind, label_es, is_system)
        VALUES ('${WS_AGENCIA}', 'coordinacion', 'agency', 'Coordinación', false) ON CONFLICT DO NOTHING;
      INSERT INTO role_permission (role_id, permission_key)
        SELECT r.id, rp.permission_key FROM role r, role_permission rp
         WHERE r.workspace_id = '${WS_AGENCIA}' AND r.key = 'coordinacion' AND rp.role_id = system_role_id('agency', 'admin')
        ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id)
        SELECT '${WS_AGENCIA}', '${COORDINADORA}', r.id FROM role r WHERE r.workspace_id = '${WS_AGENCIA}' AND r.key = 'coordinacion'
        ON CONFLICT DO NOTHING;
    `);
    const manager = await rol('agency', 'manager');
    const viewer = await rol('agency', 'viewer');
    // Antes de acotarla deja una invitación pendiente que después intentará revocar.
    const previa = await comoAdmin((tx) =>
      createInvitation(tx, { email: 'previa@agencia.test', roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() }),
    );
    assert.ok(previa.ok);
    // Y alguien a quien podría tocar sin alcance: un Ejecutivo de cuenta.
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('00000079-0000-4000-8000-0000000000e3', 'ejecutivo2@agencia.test', 'Ejecutivo Dos');
      INSERT INTO membership (workspace_id, user_id, role_id)
        VALUES ('${WS_AGENCIA}', '00000079-0000-4000-8000-0000000000e3', system_role_id('agency', 'manager'));
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_AGENCIA}', '${COORDINADORA}', 'creator', '${CREADORA}');
    `);
    try {
      assert.equal(await comoAdmin((tx) => sessionHasScope(tx)), true);
      const input = { email: 'nuevo@agencia.test', roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
      assert.deepEqual(await comoAdmin((tx) => createInvitation(tx, input)), { ok: false, code: 'scoped' });
      assert.deepEqual(await comoAdmin((tx) => changeMemberRole(tx, '00000079-0000-4000-8000-0000000000e3', viewer, [])), {
        ok: false,
        code: 'scoped',
      });
      assert.deepEqual(await comoAdmin((tx) => removeMember(tx, '00000079-0000-4000-8000-0000000000e3')), { ok: false, code: 'scoped' });
      assert.deepEqual(await comoAdmin((tx) => revokeInvitation(tx, previa.invitationId)), { ok: false, code: 'scoped' });

      // A mano, la base dice lo mismo: el alta la para la política, y el
      // cambio, la baja y la revocación no encuentran fila que tocar.
      await assert.rejects(
        comoAdmin((tx) =>
          tx.query(
            `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at)
             VALUES (current_workspace_id(), 'a-mano@agencia.test', $1, $2, current_user_id(), now() + interval '1 day')`,
            [viewer, invitationTokenHash(newInvitationToken())],
          ),
        ),
        (err) => /row-level security/i.test(mensajes(err)),
      );
      const cambio = await comoAdmin((tx) =>
        tx.query(`UPDATE membership SET role_id = $1 WHERE user_id = '00000079-0000-4000-8000-0000000000e3' RETURNING user_id`, [viewer]),
      );
      assert.equal(cambio.rows.length, 0);
      const baja = await comoAdmin((tx) =>
        tx.query(`DELETE FROM membership WHERE user_id = '00000079-0000-4000-8000-0000000000e3' RETURNING user_id`),
      );
      assert.equal(baja.rows.length, 0);
      const revocada = await comoAdmin((tx) =>
        tx.query('UPDATE invitation SET revoked_at = now() WHERE id = $1 RETURNING id', [previa.invitationId]),
      );
      assert.equal(revocada.rows.length, 0);
      // Leer el equipo sí puede.
      assert.ok((await comoAdmin((tx) => listMembers(tx))).length >= 3);
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${COORDINADORA}'`);
    }

    // Sin la fila, vuelve a poder: el alcance era lo único que la paraba.
    assert.equal(await comoAdmin((tx) => sessionHasScope(tx)), false);
    assert.deepEqual(await comoAdmin((tx) => changeMemberRole(tx, '00000079-0000-4000-8000-0000000000e3', viewer, [])), {
      ok: true,
      changed: true,
    });
    assert.deepEqual(await comoAdmin((tx) => changeMemberRole(tx, '00000079-0000-4000-8000-0000000000e3', manager, [])), {
      ok: true,
      changed: true,
    });
    assert.deepEqual(await comoAdmin((tx) => revokeInvitation(tx, previa.invitationId)), { ok: true });
  });

  test('una invitación no lleva alcance: la aceptación no lo copiaría y la persona entraría viéndolo todo', async () => {
    const viewer = await rol('creator', 'viewer');
    await assert.rejects(
      comoLaura((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, scope, token_hash, invited_by, expires_at)
           VALUES (current_workspace_id(), 'con-alcance@ejemplo.test', $1, $2::jsonb, $3, current_user_id(), now() + interval '1 day')`,
          [viewer, JSON.stringify([{ type: 'creator', id: '00000079-0000-4000-8000-00000000c0de' }]), invitationTokenHash(newInvitationToken())],
        ),
      ),
      (err) => /invitation_scope_not_yet/.test(mensajes(err)),
    );
  });
});

describe('a quien lleva alcance no se le hace Dueño ni Administrador (0082 §2, ACC-7)', () => {
  const EJECUTIVA = '00000082-0000-4000-8000-0000000000e4';
  const CREADORA = '00000082-0000-4000-8000-00000000c0de';
  const comoDuena = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS_AGENCIA, DUENA_AGENCIA, fn);

  test('changeMemberRole lo dice con su código, sin tocar el rol; sin el alcance, sí', async () => {
    const admin = await rol('agency', 'admin');
    const owner = await rol('agency', 'owner');
    const manager = await rol('agency', 'manager');
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${EJECUTIVA}', 'ejecutiva.acc7@agencia.test', 'Ejecutiva ACC-7') ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id)
        VALUES ('${WS_AGENCIA}', '${EJECUTIVA}', system_role_id('agency', 'manager')) ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_AGENCIA}', '${EJECUTIVA}', 'creator', '${CREADORA}');
    `);
    const rolDe = async () => (await comoDuena((tx) => listMembers(tx))).find((m) => m.userId === EJECUTIVA)?.roleKey;
    try {
      assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, EJECUTIVA, admin, [])), { ok: false, code: 'scoped_member' });
      assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, EJECUTIVA, owner, [])), { ok: false, code: 'scoped_member' });
      assert.equal(await rolDe(), 'manager', 'el rol no cambió');
      // A un rol que no ve todo, sí, con su alcance.
      const viewer = await rol('agency', 'viewer');
      assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, EJECUTIVA, viewer, [])), { ok: true, changed: true });
      assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, EJECUTIVA, manager, [])), { ok: true, changed: true });
      // Y la base lo para aunque se escriba a mano; isFullRoleUnscopedError lo reconoce.
      await assert.rejects(
        comoDuena((tx) => tx.query('UPDATE membership SET role_id = $1 WHERE user_id = $2', [admin, EJECUTIVA])),
        (err: unknown) => isFullRoleUnscopedError(err) && !isLastOwnerError(err),
      );
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVA}'`);
    }
    assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, EJECUTIVA, admin, [])), { ok: true, changed: true });
    assert.equal(await rolDe(), 'admin');
  });
});

describe('el rol, del tipo del espacio, también a mano (0034 §5)', () => {
  test('ni una invitación ni una membresía de un espacio de creador llevan un rol de agencia', async () => {
    const deAgencia = await rol('agency', 'viewer');
    await assert.rejects(
      comoLaura((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at)
           VALUES (current_workspace_id(), 'agencia-en-creador@ejemplo.test', $1, $2, current_user_id(), now() + interval '1 day')`,
          [deAgencia, invitationTokenHash(newInvitationToken())],
        ),
      ),
      (err) => /es de un workspace de tipo|de otro workspace/.test(mensajes(err)),
    );
    await assert.rejects(
      comoLaura((tx) => tx.query(`UPDATE membership SET role_id = $1, extra_permissions = '{}' WHERE user_id = '${BEATRIZ}'`, [deAgencia])),
      (err) => /es de un workspace de tipo|de otro workspace/.test(mensajes(err)),
    );
    // Y la consulta ni lo intenta: el rol no está entre los de este espacio.
    const input = { email: 'agencia-en-creador@ejemplo.test', roleId: deAgencia, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() };
    assert.deepEqual(await comoLaura((tx) => createInvitation(tx, input)), { ok: false, code: 'role_not_found' });
  });
});

describe('el techo de invitaciones por espacio y día (0079 §7)', () => {
  const WS_TECHO = '00000079-0000-4000-8000-00000000a7e0';
  const DUENA_TECHO = '00000079-0000-4000-8000-0000000000a7';
  const comoDuena = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS_TECHO, DUENA_TECHO, fn);

  before(async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${DUENA_TECHO}', 'techo@ejemplo.test', 'Dueña Techo');
      SELECT set_config('app.workspace_id', '${WS_TECHO}', false);
      INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_TECHO}', 'techo-0079', 'Techo 0079', 'creator');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_TECHO}', '${DUENA_TECHO}', system_role_id('creator', 'owner'));
      SELECT set_config('app.workspace_id', '', false);
    `);
  });

  test('el número de la base es INVITACIONES_POR_DIA de @mc/core', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../../db/migrations/0079_equipo_cerrojos.sql', import.meta.url)), 'utf8');
    const enLaBase = sql.match(/IF hechas >= (\d+) THEN/);
    assert.ok(enLaBase, 'invitation_daily_cap compara con un número');
    assert.equal(Number(enLaBase[1]), INVITACIONES_POR_DIA);
  });

  test(`la invitación ${INVITACIONES_POR_DIA + 1} del día da rate_limited, y no revoca la pendiente que iba a reemplazar`, async () => {
    const viewer = (await comoDuena((tx) => listTeamRoles(tx))).find((r) => r.key === 'viewer')!.id;
    const nueva = (email: string) => ({ email, roleId: viewer, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token: newInvitationToken() });
    for (let i = 0; i < INVITACIONES_POR_DIA; i++) {
      const r = await comoDuena((tx) => createInvitation(tx, nueva(`techo-${i}@ejemplo.test`)));
      assert.equal(r.ok, true, `la invitación ${i + 1} entra`);
    }
    // Una más, a otro correo, no.
    assert.deepEqual(await comoDuena((tx) => createInvitation(tx, nueva('una-mas@ejemplo.test'))), { ok: false, code: 'rate_limited' });
    // Ni «nuevo enlace» para una que ya existe: y la vieja sigue pendiente,
    // con su enlace sirviendo (el SAVEPOINT deshizo la revocación).
    assert.deepEqual(await comoDuena((tx) => createInvitation(tx, nueva('techo-0@ejemplo.test'))), { ok: false, code: 'rate_limited' });
    const pendientes = await comoDuena((tx) => listPendingInvitations(tx));
    assert.equal(pendientes.length, INVITACIONES_POR_DIA);
    assert.ok(pendientes.some((i) => i.email === 'techo-0@ejemplo.test'));
  });

  test('a mano tampoco, ni con una fecha de alta vieja: created_at lo pone la base', async () => {
    const viewer = (await comoDuena((tx) => listTeamRoles(tx))).find((r) => r.key === 'viewer')!.id;
    await assert.rejects(
      comoDuena((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at, created_at)
           VALUES (current_workspace_id(), 'vieja@ejemplo.test', $1, $2, current_user_id(), now() + interval '1 day', now() - interval '3 days')`,
          [viewer, invitationTokenHash(newInvitationToken())],
        ),
      ),
      (err) => /20 invitaciones/.test(mensajes(err)),
    );
    // El techo es por espacio: Laura, en el suyo, sigue invitando.
    const { invitationId } = await invitar('otro-espacio@ejemplo.test', 'viewer');
    const fecha = await comoLaura((tx) =>
      tx.query<{ reciente: boolean }>(`SELECT created_at > now() - interval '1 minute' AS reciente FROM invitation WHERE id = $1`, [invitationId]),
    );
    assert.equal(fecha.rows[0]?.reciente, true);
  });
});

describe('quién lee las invitaciones, y que quien invitó siga pudiendo darlo (0080)', () => {
  const WS = '00000080-0000-4000-8000-00000000a800';
  const DUENA = '00000080-0000-4000-8000-0000000000a1';
  const ADMIN = '00000080-0000-4000-8000-0000000000a2';
  const LECTORA = '00000080-0000-4000-8000-0000000000a3';
  const EJECUTIVO = '00000080-0000-4000-8000-0000000000a4';
  const INVITADA = '00000080-0000-4000-8000-0000000000a5';
  const CORREO_INVITADA = 'invitada-0080@ejemplo.test';
  const comoDuena = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS, DUENA, fn);
  const comoAdmin = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => en(WS, ADMIN, fn);
  const rolDeAgencia = async (key: string) => (await comoDuena((tx) => listTeamRoles(tx))).find((r) => r.key === key && r.isSystem)!.id;
  const pendientes = async () => (await comoDuena((tx) => listPendingInvitations(tx))).map((i) => i.id);
  const ver = (token: string) => t.db.withIdentity({ userId: INVITADA }, (tx) => lookupInvitation(tx, token));
  const esMiembro = async () => (await comoDuena((tx) => listMembers(tx))).some((m) => m.userId === INVITADA);

  /** La Administradora invita a la invitada con un rol de agencia; devuelve el token y el id. */
  async function invitaLaAdmin(key: string) {
    const token = newInvitationToken();
    const roleId = await rolDeAgencia(key);
    const r = await comoAdmin((tx) => createInvitation(tx, { email: CORREO_INVITADA, roleId, extraPermissions: [], expiresAt: EN_UNA_SEMANA(), token }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await ver(token)).status, 'pending', 'el enlace nace sirviendo');
    return { token, invitationId: r.invitationId };
  }

  /** La Administradora vuelve a serlo, a mano: cada prueba la degrada o la quita de una forma distinta. */
  const reponerAdmin = () =>
    t.admin(`
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS}', '${ADMIN}', system_role_id('agency', 'admin'))
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id;
    `);

  before(async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES
        ('${DUENA}', 'duena-0080@agencia.test', 'Dueña 0080'),
        ('${ADMIN}', 'admin-0080@agencia.test', 'Admin 0080'),
        ('${LECTORA}', 'lectora-0080@agencia.test', 'Lectora 0080'),
        ('${EJECUTIVO}', 'ejecutivo-0080@agencia.test', 'Ejecutivo 0080'),
        ('${INVITADA}', '${CORREO_INVITADA}', 'Invitada 0080');
      SELECT set_config('app.workspace_id', '${WS}', false);
      INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS}', 'agencia-0080', 'Agencia 0080', 'agency');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES
        ('${WS}', '${DUENA}', system_role_id('agency', 'owner')),
        ('${WS}', '${ADMIN}', system_role_id('agency', 'admin')),
        ('${WS}', '${LECTORA}', system_role_id('agency', 'viewer')),
        ('${WS}', '${EJECUTIVO}', system_role_id('agency', 'manager'));
      SELECT set_config('app.workspace_id', '', false);
    `);
  }, SETUP_TIMEOUT);

  test('sin equipo.miembro.ver (Solo lectura, Ejecutivo de cuenta) no se lee ninguna invitación; quien ve el equipo, sí (§1)', async () => {
    const { invitationId } = await invitaLaAdmin('viewer');
    const cuantas = (userId: string) =>
      en(WS, userId, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM invitation')).rows[0]!.n);
    assert.equal(await cuantas(LECTORA), 0, 'Solo lectura no ve los correos invitados');
    assert.equal(await cuantas(EJECUTIVO), 0, 'el Ejecutivo de cuenta tampoco');
    assert.ok((await cuantas(ADMIN)) >= 1, 'la Administradora sí');
    assert.ok((await cuantas(DUENA)) >= 1, 'y la Dueña');
    assert.deepEqual(await comoDuena((tx) => revokeInvitation(tx, invitationId)), { ok: true });
  });

  test('si degradan a quien invitó, el enlace dice revocado, no se acepta, y la invitación sale de pendientes con su bitácora (§2, §3)', async () => {
    const { token, invitationId } = await invitaLaAdmin('admin');
    const viewer = await rolDeAgencia('viewer');
    assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, ADMIN, viewer, [])), { ok: true, changed: true });

    assert.deepEqual(await ver(token), { status: 'revoked' });
    assert.deepEqual(await t.db.withIdentity({ userId: INVITADA }, (tx) => acceptInvitation(tx, token)), { status: 'revoked' });
    assert.equal(await esMiembro(), false, 'el enlace no dio Administradora');
    assert.ok(!(await pendientes()).includes(invitationId), 'ya no figura como pendiente');
    const bitacora = await comoDuena((tx) =>
      tx.query<{ action: string; reason: string | null }>(
        `SELECT action, after->>'reason' AS reason FROM audit_log WHERE entity_id = $1::uuid ORDER BY created_at, action`,
        [invitationId],
      ),
    );
    assert.deepEqual(bitacora.rows, [
      { action: 'invitation.created', reason: null },
      { action: 'invitation.revoked', reason: 'inviter_lost_access' },
    ]);
    await reponerAdmin();
  });

  test('degradada a mano, sin pasar por la aplicación: la fila sigue pendiente, pero el enlace ya no sirve (la base decide)', async () => {
    const { token, invitationId } = await invitaLaAdmin('admin');
    await t.admin(`UPDATE membership SET role_id = system_role_id('agency', 'manager') WHERE workspace_id = '${WS}' AND user_id = '${ADMIN}'`);
    assert.ok((await pendientes()).includes(invitationId));
    assert.deepEqual(await ver(token), { status: 'revoked' });
    assert.deepEqual(await t.db.withIdentity({ userId: INVITADA }, (tx) => acceptInvitation(tx, token)), { status: 'revoked' });
    assert.equal(await esMiembro(), false);
    assert.deepEqual(await comoDuena((tx) => revokeInvitation(tx, invitationId)), { ok: true });
    await reponerAdmin();
  });

  test('si la quitan del espacio, igual; lo que todavía podría dar sigue sirviendo', async () => {
    // Degradada a Ejecutivo de cuenta ya no invita: ni siquiera a otro Ejecutivo.
    const { token: deEjecutivo } = await invitaLaAdmin('manager');
    const ejecutivo = await rolDeAgencia('manager');
    assert.deepEqual(await comoDuena((tx) => changeMemberRole(tx, ADMIN, ejecutivo, [])), { ok: true, changed: true });
    assert.deepEqual(await ver(deEjecutivo), { status: 'revoked' }, 'sin equipo.miembro.invitar no firma ninguna');
    await reponerAdmin();

    const { token, invitationId } = await invitaLaAdmin('viewer');
    assert.deepEqual(await comoDuena((tx) => removeMember(tx, ADMIN)), { ok: true });
    assert.deepEqual(await ver(token), { status: 'revoked' });
    assert.ok(!(await pendientes()).includes(invitationId));
    await reponerAdmin();

    // Y si quien invitó conserva lo que dio, el enlace sirve.
    const sigue = await invitaLaAdmin('viewer');
    assert.equal((await t.db.withIdentity({ userId: INVITADA }, (tx) => acceptInvitation(tx, sigue.token))).status, 'ok');
    assert.equal(await esMiembro(), true);
  });
});
