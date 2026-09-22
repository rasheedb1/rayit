/**
 * La costura de la sesión (CIM-3) contra las políticas reales.
 *
 * Todo corre sobre Postgres embebido como mc_app, sin BYPASSRLS y con
 * las migraciones del repositorio aplicadas: si 0019, 0020, 0021 o 0022
 * cambian, esto se rompe. Lo que se comprueba:
 *
 *   - con el correo fijado se encuentra (o se crea) la propia fila de
 *     app_user, y solo la propia: el correo de otra persona sigue
 *     invisible;
 *   - el alta es idempotente y no choca contra el único de email;
 *   - «a qué espacios pertenezco» sale de membership como mc_app, sin
 *     asWorker, y no enseña los de nadie más;
 *   - el espacio nuevo nace completo (workspace, membresía de dueña,
 *     creator_profile) dentro de una sola transacción;
 *   - sin identidad fijada, ninguna de esas lecturas devuelve nada.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appUser, creatorProfile, eq, membership } from '../src/index.ts';
import {
  createCreatorWorkspace, freeSlug, getAppUser, isMemberOf, listMyWorkspaces, nameFromEmail, slugify,
  updateMyName, upsertAppUserPorCorreo,
} from '../src/queries/identidad.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const CORREO_A = 'ana@ejemplo.test';
const CORREO_B = 'bruno@ejemplo.test';
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
    assert.equal(nameFromEmail('ana_maria+trabajo@x.co'), 'Ana Maria Trabajo');
    assert.equal(nameFromEmail('LAURA@x.co'), 'LAURA');
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
    const primera = await t.db.withIdentity({ email: CORREO_A }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_A }));
    idA = primera.id;
    assert.equal(primera.email, CORREO_A);
    assert.equal(primera.name, 'Ana');

    // Mismo correo con otras mayúsculas: citext, así que es la misma persona.
    const segunda = await t.db.withIdentity({ email: 'ANA@Ejemplo.test' }, (tx) =>
      upsertAppUserPorCorreo(tx, { email: 'ANA@Ejemplo.test' }),
    );
    assert.equal(segunda.id, idA);

    const otra = await t.db.withIdentity({ email: CORREO_B }, (tx) => upsertAppUserPorCorreo(tx, { email: CORREO_B }));
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
    const otra = await t.db.withIdentity({ email: CORREO_A }, (tx) =>
      upsertAppUserPorCorreo(tx, { email: CORREO_A, name: 'Del correo' }),
    );
    assert.equal(otra.name, 'Ana Restrepo');
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
