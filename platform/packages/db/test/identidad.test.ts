/**
 * La costura de la sesión (CIM-3) contra las políticas reales.
 *
 * Todo corre sobre Postgres embebido como mc_app, sin BYPASSRLS y con
 * las migraciones del repositorio aplicadas: si 0019, 0020, 0021,
 * sesion_correo_verificado o membership_alta_propia cambian, esto se
 * rompe. Lo que se comprueba:
 *
 *   - con el correo fijado se encuentra (o se crea) la propia fila de
 *     app_user, y solo la propia: el correo de otra persona sigue
 *     invisible;
 *   - el alta es idempotente y no choca contra el único de email;
 *   - la fila queda ligada a la cuenta de Auth que entró primero: otra
 *     cuenta con el mismo correo no la hereda, ni al leer ni al entrar;
 *   - «a qué espacios pertenezco» sale de membership como mc_app, sin
 *     asWorker, y no enseña los de nadie más;
 *   - el espacio nuevo nace completo (workspace, membresía de dueña,
 *     creator_profile) dentro de una sola transacción;
 *   - sin identidad fijada, ninguna de esas lecturas devuelve nada;
 *   - (membership_alta_propia) fijar mi id me deja LEER mis membresías, no escribir: no
 *     me cuelgo de un espacio ajeno, no cuelgo a otra persona del mío,
 *     y no me cambio el rol;
 *   - renombrar un espacio arrastra la ficha que nació con su nombre.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appUser, creatorProfile, eq, membership, workspace } from '../src/index.ts';
import {
  AuthIdentityMismatchError, createCreatorWorkspace, freeSlug, getAppUser, getMyIdentityAndWorkspaces, isMemberOf,
  listMyWorkspaces, nameFromEmail, renameWorkspace, slugify, updateMyName, upsertAppUserPorCorreo,
} from '../src/queries/identidad.ts';
import { openTestDb, type TestDb } from './pglite.ts';

/** Drizzle envuelve el error de Postgres; el motivo real va en `cause`. */
function esViolacionRls(err: unknown): boolean {
  const partes: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return /row-level security/.test(partes.join(' ← '));
}

const CORREO_A = 'ana@ejemplo.test';
const CORREO_B = 'bruno@ejemplo.test';
/** Ids de auth.users (Supabase Auth), que NO son los de app_user. */
const AUTH_A = '0000000a-0000-4000-8000-00000000000a';
const AUTH_B = '0000000a-0000-4000-8000-00000000000b';
const AUTH_INTRUSA = '0000000a-0000-4000-8000-0000000000ff';
const WS_NUEVO = '0000000f-0000-4000-8000-000000000001';

let t: TestDb;
let idA = '';
let idB = '';

before(async () => {
  t = await openTestDb({ seeds: false });
});

after(async () => {
  await t?.close();
});

describe('nombres y slugs a partir del correo', () => {
  test('el nombre sale del correo, sin inventar', () => {
    assert.equal(nameFromEmail('laura.mendez@ejemplo.com'), 'Laura Mendez');
    assert.equal(nameFromEmail('LAURA@x.co'), 'LAURA');
    // La subdirección no es parte del nombre: con ella, el espacio de
    // 'revisor.cim3.r2+mudh604g@…' se llamaba 'Revisor Cim3 R2 Mudh604g'.
    assert.equal(nameFromEmail('ana_maria+trabajo@x.co'), 'Ana Maria');
    assert.equal(nameFromEmail('revisor.cim3.r2+mudh604g@ejemplo.test'), 'Revisor Cim3 R2');
    assert.equal(nameFromEmail('+solo-alias@x.co'), null);
    // Sin nada legible, quien llama pone el texto por defecto.
    assert.equal(nameFromEmail('123@x.co'), null);
    assert.equal(nameFromEmail('@x.co'), null);
  });

  test('el slug es ascii, en minúsculas y con guiones', () => {
    assert.equal(slugify('Laura Méndez'), 'laura-mendez');
    assert.equal(slugify('  Café & Alma  '), 'cafe-alma');
    assert.equal(slugify('###'), 'espacio');
  });
});

describe('app_user con el correo de la sesión', () => {
  test('crea la fila la primera vez y la devuelve la segunda', async () => {
    const primera = await t.db.withIdentity({ email: CORREO_A, userId: randomUUID() }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_A, authUserId: AUTH_A }));
    idA = primera.id;
    assert.equal(primera.authUserId, AUTH_A);
    assert.equal(primera.email, CORREO_A);
    assert.equal(primera.name, 'Ana');

    // Mismo correo con otras mayúsculas: citext, así que es la misma persona.
    const segunda = await t.db.withIdentity({ email: 'ANA@Ejemplo.test', userId: randomUUID() }, (tx) =>
      upsertAppUserPorCorreo(tx, { email: 'ANA@Ejemplo.test', authUserId: AUTH_A }),
    );
    assert.equal(segunda.id, idA);

    const otra = await t.db.withIdentity({ email: CORREO_B, userId: randomUUID() }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_B, authUserId: AUTH_B }));
    idB = otra.id;
    assert.notEqual(idB, idA);
  });

  test('con mi correo veo mi fila y solo la mía', async () => {
    const filas = await t.db.withIdentity({ email: CORREO_A, userId: idA }, (tx) =>
      tx.db.select({ email: appUser.email }).from(appUser),
    );
    assert.deepEqual(filas, [{ email: CORREO_A }]);

    const ajena = await t.db.withIdentity({ email: CORREO_A, userId: idA }, (tx) =>
      tx.db.select({ email: appUser.email }).from(appUser).where(eq(appUser.id, idB)),
    );
    assert.deepEqual(ajena, []);
  });

  test('sin identidad fijada, app_user no devuelve nada', async () => {
    const filas = await t.db.withCatalogs((tx) => tx.query('SELECT id FROM app_user'));
    assert.equal(filas.rows.length, 0);
  });

  test('edito mi nombre; el de otra persona no se deja', async () => {
    const mio = await t.db.withIdentity({ email: CORREO_A, userId: idA }, (tx) => updateMyName(tx, idA, 'Ana Restrepo'));
    assert.equal(mio?.name, 'Ana Restrepo');

    const ajeno = await t.db.withIdentity({ email: CORREO_A, userId: idA }, (tx) => updateMyName(tx, idB, 'Suplantada'));
    assert.equal(ajeno, null);

    const sigueIgual = await t.db.withIdentity({ email: CORREO_B, userId: idB }, (tx) => getAppUser(tx, idB));
    assert.equal(sigueIgual?.name, 'Bruno');
  });

  test('el alta no pisa un nombre ya escrito', async () => {
    const otra = await t.db.withIdentity({ email: CORREO_A, userId: randomUUID() }, (tx) =>
      upsertAppUserPorCorreo(tx, { email: CORREO_A, name: 'Del correo', authUserId: AUTH_A }),
    );
    assert.equal(otra.name, 'Ana Restrepo');
  });
});

describe('la fila es de la cuenta de Auth que entró primero', () => {
  test('otra cuenta con el mismo correo no hereda la fila al LEER', async () => {
    // El buzón se reasignó: la cuenta de Auth vieja se borró y otra
    // persona se registró con el mismo correo. Su sesión trae otro id.
    await assert.rejects(
      () => t.db.withIdentity({ email: CORREO_A }, (tx) => getMyIdentityAndWorkspaces(tx, AUTH_INTRUSA)),
      (err: unknown) => err instanceof AuthIdentityMismatchError && err.appUserId === idA,
    );
    // La dueña sigue entrando.
    const mia = await t.db.withIdentity({ email: CORREO_A }, (tx) => getMyIdentityAndWorkspaces(tx, AUTH_A));
    assert.equal(mia?.user.id, idA);
  });

  test('ni al ENTRAR: el upsert no toca la fila y lanza', async () => {
    await assert.rejects(
      () => t.db.withIdentity({ email: CORREO_A, userId: randomUUID() }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_A, authUserId: AUTH_INTRUSA })),
      AuthIdentityMismatchError,
    );
    const sigue = await t.db.withIdentity({ email: CORREO_A, userId: idA }, (tx) => getAppUser(tx, idA));
    assert.equal(sigue?.authUserId, AUTH_A);
  });

  test('una fila sin cuenta todavía (seed, invitación) se enlaza con la primera que entra', async () => {
    const correo = 'invitada@ejemplo.test';
    // Así la deja un seed: sin auth_user_id.
    const idInvitada = randomUUID();
    await t.db.withIdentity({ email: correo, userId: idInvitada }, (tx) => tx.db.insert(appUser).values({ id: idInvitada, email: correo }));
    const leida = await t.db.withIdentity({ email: correo }, (tx) => getMyIdentityAndWorkspaces(tx, AUTH_INTRUSA));
    assert.equal(leida?.user.authUserId, null, 'leer no escribe');
    const enlazada = await t.db.withIdentity({ email: correo, userId: randomUUID() }, (tx) =>
      upsertAppUserPorCorreo(tx, { email: correo, authUserId: AUTH_INTRUSA }),
    );
    assert.equal(enlazada.authUserId, AUTH_INTRUSA);
  });

  test('sin id nuevo en la identidad no hay alta (la política de endurecer-db lo exige)', async () => {
    await assert.rejects(
      () => t.db.withIdentity({ email: CORREO_B }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_B, authUserId: AUTH_B })),
      /userId: <id nuevo>/,
    );
  });

  test('la misma cuenta de Auth no puede tener dos filas (cambio de correo en Supabase)', async () => {
    await assert.rejects(
      () =>
        t.db.withIdentity({ email: 'ana.nueva@ejemplo.test', userId: randomUUID() }, (tx) =>
          upsertAppUserPorCorreo(tx, { email: 'ana.nueva@ejemplo.test', authUserId: AUTH_A }),
        ),
      (err: unknown) => err instanceof AuthIdentityMismatchError && err.motivo === 'otro_correo',
    );
  });
});

describe('espacios de la persona que entra', () => {
  test('sin membresías, la lista está vacía', async () => {
    const mios = await t.db.withIdentity({ userId: idA }, (tx) => listMyWorkspaces(tx));
    assert.deepEqual(mios, []);
  });

  test('el espacio nuevo nace con su dueña y su ficha de creadora', async () => {
    const slug = await t.db.withIdentity({ userId: idA }, (tx) => freeSlug(tx, 'Ana Restrepo'));
    assert.equal(slug, 'ana-restrepo');

    const creado = await t.db.withWorkspace(
      WS_NUEVO,
      (tx) => createCreatorWorkspace(tx, { workspaceId: WS_NUEVO, userId: idA, name: 'Ana Restrepo', slug }),
      { userId: idA, email: CORREO_A },
    );
    assert.deepEqual(creado, { id: WS_NUEVO, name: 'Ana Restrepo', slug, kind: 'creator', role: 'owner' });

    const mios = await t.db.withIdentity({ userId: idA }, (tx) => listMyWorkspaces(tx));
    assert.deepEqual(mios, [{ id: WS_NUEVO, name: 'Ana Restrepo', slug, kind: 'creator', role: 'owner' }]);

    const perfiles = await t.db.withWorkspace(
      WS_NUEVO,
      (tx) => tx.db.select({ displayName: creatorProfile.displayName }).from(creatorProfile),
      { userId: idA },
    );
    assert.deepEqual(perfiles, [{ displayName: 'Ana Restrepo' }]);
  });

  test('el segundo espacio con el mismo nombre no choca de slug', async () => {
    const slug = await t.db.withIdentity({ userId: idA }, (tx) => freeSlug(tx, 'Ana Restrepo'));
    assert.equal(slug, 'ana-restrepo-2');
  });

  test('aunque la sugerencia de slug ya esté cogida, el alta no choca: prueba el siguiente', async () => {
    // Es lo que pasa con dos altas a la vez, o cuando workspace lleve RLS
    // y freeSlug solo vea el propio: la garantía la da el índice.
    const WS_OTRO = '0000000f-0000-4000-8000-000000000003';
    const creado = await t.db.withWorkspace(
      WS_OTRO,
      (tx) => createCreatorWorkspace(tx, { workspaceId: WS_OTRO, userId: idA, name: 'Ana Restrepo', slug: 'ana-restrepo' }),
      { userId: idA },
    );
    assert.equal(creado.slug, 'ana-restrepo-2');
  });

  test('otra persona no ve ese espacio ni cuenta como miembro', async () => {
    const suyos = await t.db.withIdentity({ userId: idB }, (tx) => listMyWorkspaces(tx));
    assert.deepEqual(suyos, []);

    const esMiembro = await t.db.withIdentity({ userId: idB }, (tx) => isMemberOf(tx, WS_NUEVO, idB));
    assert.equal(esMiembro, false);

    const laDuena = await t.db.withIdentity({ userId: idA }, (tx) => isMemberOf(tx, WS_NUEVO, idA));
    assert.equal(laDuena, true);
  });

  test('sin identidad fijada, membership no devuelve nada', async () => {
    const filas = await t.db.withCatalogs((tx) => tx.db.select().from(membership));
    assert.deepEqual(filas, []);
  });

  test('con mi userId no puedo insertar membresía en un espacio ajeno (membership_alta_propia)', async () => {
    // Era la rama «user_id = current_user_id()» de 0019, FOR ALL y sin
    // WITH CHECK: con CIM-3 fijando app.user_id, esto pasaba sin error.
    await assert.rejects(
      () =>
        t.db.withIdentity({ userId: idB }, (tx) =>
          tx.db.insert(membership).values({ workspaceId: WS_NUEVO, userId: idB, role: 'owner' }),
        ),
      esViolacionRls,
    );
    assert.equal(await t.db.withIdentity({ userId: idB }, (tx) => isMemberOf(tx, WS_NUEVO, idB)), false);
  });

  test('dentro de mi espacio no puedo dar de alta a otra persona (membership_alta_propia)', async () => {
    await assert.rejects(
      () =>
        t.db.withWorkspace(
          WS_NUEVO,
          (tx) => tx.db.insert(membership).values({ workspaceId: WS_NUEVO, userId: idB, role: 'admin' }),
          { userId: idA },
        ),
      esViolacionRls,
    );
  });

  test('ni cambiar roles ni borrar membresías desde la web (membership_alta_propia)', async () => {
    // Sin política de UPDATE ni de DELETE, las dos sentencias no ven
    // ninguna fila: no fallan, pero no tocan nada.
    const cambiadas = await t.db.withWorkspace(
      WS_NUEVO,
      (tx) => tx.db.update(membership).set({ role: 'viewer' }).where(eq(membership.userId, idA)).returning(),
      { userId: idA },
    );
    assert.deepEqual(cambiadas, []);
    const borradas = await t.db.withIdentity({ userId: idA }, (tx) =>
      tx.db.delete(membership).where(eq(membership.userId, idA)).returning(),
    );
    assert.deepEqual(borradas, []);
    assert.equal(await t.db.withIdentity({ userId: idA }, (tx) => isMemberOf(tx, WS_NUEVO, idA)), true);
  });

  test('renombrar el espacio arrastra la ficha que nació con su nombre, y no pisa una ya editada', async () => {
    const ok = await t.db.withWorkspace(WS_NUEVO, (tx) => renameWorkspace(tx, '  Cocina de Ana  '), { userId: idA });
    assert.equal(ok, true);
    const [ws] = await t.db.withWorkspace(WS_NUEVO, (tx) => tx.db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, WS_NUEVO)), { userId: idA });
    assert.equal(ws?.name, 'Cocina de Ana');
    const fichas = await t.db.withWorkspace(WS_NUEVO, (tx) => tx.db.select({ d: creatorProfile.displayName }).from(creatorProfile), { userId: idA });
    assert.deepEqual(fichas, [{ d: 'Cocina de Ana' }]);

    // La creadora le pone otro nombre a su ficha; renombrar el espacio ya no la toca.
    await t.db.withWorkspace(WS_NUEVO, (tx) => tx.db.update(creatorProfile).set({ displayName: 'Ana R.' }), { userId: idA });
    await t.db.withWorkspace(WS_NUEVO, (tx) => renameWorkspace(tx, 'Ana · Recetas'), { userId: idA });
    const despues = await t.db.withWorkspace(WS_NUEVO, (tx) => tx.db.select({ d: creatorProfile.displayName }).from(creatorProfile), { userId: idA });
    assert.deepEqual(despues, [{ d: 'Ana R.' }]);
  });

  test('createCreatorWorkspace se niega si la transacción fijó otro espacio', async () => {
    await assert.rejects(
      () =>
        t.db.withWorkspace(
          WS_NUEVO,
          (tx) => createCreatorWorkspace(tx, { workspaceId: '0000000f-0000-4000-8000-000000000002', userId: idA, name: 'X', slug: 'x' }),
          { userId: idA },
        ),
      /dentro de withWorkspace/,
    );
  });

  test('withIdentity sin identidad lanza en vez de abrir una transacción ciega', async () => {
    await assert.rejects(() => t.db.withIdentity({}, async () => null), /withIdentity necesita/);
  });

  test('un userId que no es UUID lanza antes de tocar la base', async () => {
    await assert.rejects(() => t.db.withIdentity({ userId: 'ana' }, async () => null), /user_id inválido/);
  });
});
