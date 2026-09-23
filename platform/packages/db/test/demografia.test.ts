/**
 * CON-7 · el contrato de lectura que consume RES-4: la última
 * demografía de una cuenta, o la razón de que no haya.
 *
 * Lo que se exige aquí: que traiga SOLO el último día, que el orden de
 * los buckets sea el que la pantalla necesita, que los numeric y los
 * bigint lleguen como números y no como cadenas, que una ausencia venga
 * con su frase en español, y que el workspace vecino no vea nada.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAccountAudience, listAccountAudience } from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WORKSPACE_VECINO = '00000007-0000-4000-8000-0000000000c1';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const CREATOR_VECINO = '00000007-0000-4000-8000-0000000000c2';
const CONN_IG = '00000007-0000-4000-8000-0000000000d1';
const CONN_TT = '00000007-0000-4000-8000-0000000000d2';
const CONN_VECINO = '00000007-0000-4000-8000-0000000000d3';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_VECINO}', 'vecino-demo', 'Vecino') ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR_VECINO}', '${WORKSPACE_VECINO}', 'Vecino') ON CONFLICT DO NOTHING;

    INSERT INTO social_connection (id, workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, account_type) VALUES
      ('${CONN_IG}', '${WORKSPACE_LAURA}', '${CREATOR_LAURA}', 'instagram', '17841400000007001', 'cafealma.demo', 'enc:instagram:demo7', '{}', 'direct_oauth', 'business'),
      ('${CONN_TT}', '${WORKSPACE_LAURA}', '${CREATOR_LAURA}', 'tiktok', 'open_id_demo7', 'laura.porarroba', 'public:tiktok:laura.porarroba', '{}', 'public_profile', 'unknown'),
      ('${CONN_VECINO}', '${WORKSPACE_VECINO}', '${CREATOR_VECINO}', 'instagram', '17841400000007009', 'vecino', 'enc:instagram:vecino7', '{}', 'direct_oauth', 'business');

    -- Un día viejo que NO debe salir, y el día bueno.
    INSERT INTO audience_breakdown (workspace_id, scope, connection_id, day, population, dimension, bucket, share, absolute) VALUES
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-01', 'followers', 'age', '25-34', NULL, 1),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'followers', 'age', '25-34', NULL, 164000),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'followers', 'age', '18-24', NULL, 98000),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'followers', 'age', '13-17', NULL, 8200),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'followers', 'country', 'MX', NULL, 22000),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'followers', 'country', 'CO', NULL, 350000),
      ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-23', 'viewers', 'age_gender', '25-34|F', 0.279, NULL),
      ('${WORKSPACE_VECINO}', 'account', '${CONN_VECINO}', '2026-09-23', 'followers', 'age', '25-34', NULL, 7);

    INSERT INTO metric_gap (workspace_id, connection_id, metric_group, requirement_id, day) VALUES
      ('${WORKSPACE_LAURA}', '${CONN_TT}', 'demografia_de_cuenta', 'tt.audience.auth', '2026-09-23');
  `);
});
after(async () => { await t.close(); });

describe('la última demografía de una cuenta', () => {
  test('solo el último día, con la edad en su orden y el país por tamaño', async () => {
    const a = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getAccountAudience(tx, CONN_IG)))!;
    assert.equal(a.day, '2026-09-23', 'el día viejo no se mezcla con el nuevo');
    assert.equal(a.platformId, 'instagram');
    assert.equal(a.handle, 'cafealma.demo');
    assert.deepEqual(a.gaps, [], 'con dato no hay hueco');

    const edad = a.dimensions.find((d) => d.dimension === 'age')!;
    assert.equal(edad.population, 'followers');
    assert.deepEqual(edad.buckets.map((b) => b.bucket), ['13-17', '18-24', '25-34'], 'la edad va en su orden natural, no por tamaño');
    assert.deepEqual(edad.buckets.map((b) => b.absolute), [8200, 98000, 164000]);
    assert.ok(edad.buckets.every((b) => b.share === null), 'Instagram da absolutos: el share es null, no cero');
    assert.equal(typeof edad.buckets[0]!.absolute, 'number', 'el bigint llega convertido, no como cadena');

    const pais = a.dimensions.find((d) => d.dimension === 'country')!;
    assert.deepEqual(pais.buckets.map((b) => b.bucket), ['CO', 'MX'], 'el país va por tamaño');
    assert.equal(edad.day, '2026-09-23');
    assert.equal(pais.day, '2026-09-23');

    const edadGenero = a.dimensions.find((d) => d.dimension === 'age_gender')!;
    assert.equal(edadGenero.population, 'viewers', 'la misma cuenta puede tener dos poblaciones');
    assert.equal(edadGenero.buckets[0]!.share, 0.279);
    assert.equal(edadGenero.buckets[0]!.absolute, null);
  });

  test('sin demografía, la razón; y es la frase de la migración, no una inventada aquí', async () => {
    const a = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getAccountAudience(tx, CONN_TT)))!;
    assert.equal(a.day, null, 'nunca hubo demografía: null, no un cero ni un guion');
    assert.deepEqual(a.dimensions, []);
    assert.equal(a.gaps.length, 1);
    const [g] = a.gaps;
    assert.equal(g!.requirementId, 'tt.audience.auth');
    assert.equal(g!.requirement, 'owner_authorization');
    assert.equal(g!.metricGroup, 'demografia_de_cuenta');
    assert.equal(g!.day, '2026-09-23');
    assert.match(g!.messageEs, /el dueño tiene que autorizarla/);
    assert.ok(!/se agregó por su @/.test(g!.messageEs), 'la frase vale también para una autorización caída');
    assert.ok(g!.detectedAt.endsWith('Z'), 'las timestamptz salen como ISO en UTC');
  });
});

describe('un día en que la plataforma entrega menos', () => {
  test('el corte que hoy no llegó sigue siendo el de la última vez, y no desaparece de la pantalla', async () => {
    // El 24 llega la edad, pero no el país: Analytics devolvió su tabla
    // vacía. Si el contrato mirara solo el último día de la CUENTA, el
    // país que sí se leyó el 23 se borraría de la pantalla sin que nadie
    // lo pudiera explicar.
    await t.admin(`
      INSERT INTO audience_breakdown (workspace_id, scope, connection_id, day, population, dimension, bucket, share, absolute) VALUES
        ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-24', 'followers', 'age', '25-34', NULL, 170000),
        ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-24', 'followers', 'age', '18-24', NULL, 99000),
        ('${WORKSPACE_LAURA}', 'account', '${CONN_IG}', '2026-09-24', 'followers', 'age', '13-17', NULL, 8300);
    `);
    const a = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getAccountAudience(tx, CONN_IG)))!;
    assert.equal(a.day, '2026-09-24', 'el de la cuenta es el más reciente de sus dimensiones');

    const edad = a.dimensions.find((d) => d.dimension === 'age')!;
    assert.equal(edad.day, '2026-09-24');
    assert.deepEqual(edad.buckets.map((b) => b.absolute), [8300, 99000, 170000], 'la edad es la de hoy, sin mezclarse con la de ayer');

    const pais = a.dimensions.find((d) => d.dimension === 'country')!;
    assert.equal(pais.day, '2026-09-23', 'y el país sigue ahí, con su propio «datos hasta»');
    assert.deepEqual(pais.buckets.map((b) => b.bucket), ['CO', 'MX']);
  });
});

describe('aislamiento', () => {
  test('el vecino no ve la demografía de Laura ni por id, ni en la lista', async () => {
    const ajena = await t.db.withWorkspace(WORKSPACE_VECINO, (tx) => getAccountAudience(tx, CONN_IG));
    assert.equal(ajena, null, 'una conexión de otro workspace no existe para este');

    const suyas = await t.db.withWorkspace(WORKSPACE_VECINO, (tx) => listAccountAudience(tx));
    assert.deepEqual(suyas.map((s) => s.connectionId), [CONN_VECINO]);
    assert.deepEqual(suyas[0]!.dimensions[0]!.buckets, [{ bucket: '25-34', share: null, absolute: 7 }]);

    const mias = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccountAudience(tx));
    assert.ok(mias.some((m) => m.connectionId === CONN_IG));
    assert.ok(!mias.some((m) => m.connectionId === CONN_VECINO));
    assert.ok(mias.every((m) => m.dimensions.every((d) => d.buckets.every((b) => b.absolute !== 7))), 'ni una fila del vecino se cuela');
  });

  test('la web no puede escribir ni borrar lo que mide el worker (0038)', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`DELETE FROM metric_gap WHERE connection_id = $1`, [CONN_TT])),
      /permiso|permission/i,
      'borrar la explicación de un hueco no es una pantalla',
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(
        `INSERT INTO audience_breakdown (workspace_id, scope, connection_id, day, population, dimension, bucket, absolute)
         VALUES (current_workspace_id(), 'account', $1, '2026-09-23', 'followers', 'age', '25-34', 999999)`, [CONN_IG])),
      /permiso|permission/i,
      'las métricas las inserta quien mide',
    );
  });
});
