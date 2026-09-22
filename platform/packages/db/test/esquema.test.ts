/**
 * La comprobación de que la base tiene el esquema del repositorio
 * (src/esquema.ts), que createDbFromEnv hace una vez al construir el
 * cliente.
 *
 * Hace falta porque el contrato del paquete —«RLS aísla cada
 * workspace»— no lo cumple el código sino las políticas que dejó
 * db/migrations: contra una base atrasada todo compila, todas las rutas
 * responden 200 y el aislamiento simplemente no existe. Pasó, y el
 * único aviso vivía en una nota del backlog que nadie lee en tiempo de
 * ejecución.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSchemaUpToDate, ESQUEMA_AL_DIA, esquemaObligatorio, estadoDelEsquema, EXCEPCIONES_SIN_AISLAMIENTO,
  explicarEsquema, migracionesDelRepositorio, type EstadoDelEsquema,
} from '../src/esquema.ts';
import { openTestDb, type TestDb } from './pglite.ts';

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

const AL_DIA: EstadoDelEsquema = { ...ESQUEMA_AL_DIA, aplicadas: 22, ultima: '0022_x.sql' };

describe('estadoDelEsquema contra una base recién migrada', () => {
  test('no falta ninguna migración, ninguna tabla se quedó sin aislar y mc_app no tiene privilegios de más', async () => {
    const estado = await estadoDelEsquema(t.db);
    assert.equal(estado.comparadoConArchivos, true);
    assert.deepEqual(estado.pendientes, [], 'la base embebida aplica db/migrations con el mismo runner');
    assert.deepEqual(estado.sinRls, []);
    assert.deepEqual(estado.sinAislar, []);
    assert.deepEqual(estado.excepcionesObsoletas, []);
    assert.deepEqual(estado.privilegiosDeMas, [], JSON.stringify(estado.privilegiosDeMas));
    assert.equal(estado.aplicadas, (await migracionesDelRepositorio()).length);
    assert.equal(estado.ultima, (await migracionesDelRepositorio()).at(-1));
    assert.equal(explicarEsquema(estado), null);
  });

  test('la guardia pregunta por TODAS las tablas de la base, no por una lista del repositorio', async () => {
    // Es lo que cambió en el endurecimiento: antes se enumeraban 53
    // tablas a mano y una nueva sin política pasaba en verde por no
    // estar en ninguna lista. Ahora lo escrito a mano es solo la lista
    // de excepciones, y es corta.
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      ),
    );
    const tablas = rows[0]?.n ?? 0;
    assert.ok(tablas > 80, `solo ${tablas} tablas en la base`);
    const excepciones = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).length;
    assert.ok(excepciones < tablas / 4, `${excepciones} excepciones sobre ${tablas} tablas: la puerta es demasiado ancha`);
  });

  test('una tabla nueva sin política la nombra, aunque no esté en ninguna lista', async () => {
    // El caso que la guardia vieja no veía. No hace falta tocar una
    // tabla conocida: basta con crear una que nadie declaró.
    await t.admin('CREATE TABLE tabla_nueva_sin_politica (id uuid PRIMARY KEY, workspace_id uuid)');
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.sinRls, ['tabla_nueva_sin_politica']);
      assert.equal(estado.sinAislar[0]?.falta, 'sin ENABLE ROW LEVEL SECURITY');
      assert.match(String(explicarEsquema(estado)), /tabla_nueva_sin_politica/);
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /tabla_nueva_sin_politica/);
    } finally {
      await t.admin('DROP TABLE tabla_nueva_sin_politica');
    }
  });

  test('una tabla a la que le quitan la RLS aparece nombrada', async () => {
    await t.admin('ALTER TABLE contact DISABLE ROW LEVEL SECURITY');
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.sinRls, ['contact']);
      assert.match(String(explicarEsquema(estado)), /contact/);
      assert.match(String(explicarEsquema(estado)), /make db\.migrate/);
      // En producción eso no arranca; en desarrollo avisa y sigue.
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /contact/);
      const avisos: string[] = [];
      await assertSchemaUpToDate(t.db, { warn: (m) => avisos.push(m) });
      assert.equal(avisos.length, 1);
    } finally {
      await t.admin('ALTER TABLE contact ENABLE ROW LEVEL SECURITY');
    }
  });

  test('con RLS pero SIN FORCE tampoco pasa: el dueño de la tabla se la saltaría', async () => {
    await t.admin('ALTER TABLE contact NO FORCE ROW LEVEL SECURITY');
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.sinRls, ['contact']);
      assert.match(String(estado.sinAislar[0]?.falta), /FORCE/);
    } finally {
      await t.admin('ALTER TABLE contact FORCE ROW LEVEL SECURITY');
    }
  });

  test('un GRANT que devuelve la escritura de un catálogo se reporta con su motivo', async () => {
    // El camino real: cualquier script de mantenimiento con un
    // `GRANT … ON ALL TABLES IN SCHEMA public TO mc_app` deshace en
    // silencio lo que la migración 0022 revocó.
    await t.admin('GRANT INSERT, UPDATE ON platform TO mc_app');
    try {
      const estado = await estadoDelEsquema(t.db);
      const platform = estado.privilegiosDeMas.find((p) => p.tabla === 'platform');
      assert.deepEqual(platform?.privilegios, ['INSERT', 'UPDATE']);
      assert.match(String(explicarEsquema(estado)), /platform \(INSERT, UPDATE/);
    } finally {
      await t.admin('REVOKE INSERT, UPDATE ON platform FROM mc_app');
    }
  });

  test('una excepción que ya no corresponde también se reporta: la lista no se pudre', async () => {
    await t.admin('ALTER TABLE platform ENABLE ROW LEVEL SECURITY; ALTER TABLE platform FORCE ROW LEVEL SECURITY; CREATE POLICY platform_todo ON platform USING (true)');
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.excepcionesObsoletas, ['platform']);
      assert.match(String(explicarEsquema(estado)), /sobran excepciones/);
    } finally {
      await t.admin('DROP POLICY platform_todo ON platform; ALTER TABLE platform NO FORCE ROW LEVEL SECURITY; ALTER TABLE platform DISABLE ROW LEVEL SECURITY');
    }
  });

  test('sin schema_migrations (base nunca migrada) lo dice, en vez de dar por buena la base', () => {
    const estado: EstadoDelEsquema = { ...AL_DIA, aplicadas: -1, ultima: null, pendientes: [] };
    assert.match(String(explicarEsquema(estado)), /nunca se migró/);
  });
});

describe('explicarEsquema', () => {
  test('al día, no dice nada', () => {
    assert.equal(explicarEsquema(AL_DIA), null);
  });

  test('con migraciones pendientes, las nombra y dice cuántas son', () => {
    const msg = String(
      explicarEsquema({ ...AL_DIA, aplicadas: 15, ultima: '0015_connection_secret.sql', pendientes: ['0019_a.sql', '0020_b.sql'] }),
    );
    assert.match(msg, /faltan 2 migración\(es\)/);
    assert.match(msg, /0015_connection_secret\.sql/);
    assert.match(msg, /0019_a\.sql, 0020_b\.sql/);
    assert.match(msg, /make db\.migrate/);
  });

  test('con tablas sin aislar, explica qué significa: devuelven las filas de todos', () => {
    const msg = String(explicarEsquema({ ...AL_DIA, sinRls: ['membership', 'contact'] }));
    assert.match(msg, /membership, contact/);
    assert.match(msg, /todos los workspaces/i);
    assert.match(msg, /EXCEPCIONES_SIN_AISLAMIENTO/, 'dice también cuál es la salida declarada');
  });

  test('con privilegios de más, dice cuál y por qué no le tocan', () => {
    const msg = String(
      explicarEsquema({
        ...AL_DIA,
        privilegiosDeMas: [{ tabla: 'platform', privilegios: ['INSERT', 'DELETE'], motivo: 'catálogo global de solo lectura' }],
      }),
    );
    assert.match(msg, /mc_app tiene privilegios que no le tocan/);
    assert.match(msg, /platform \(INSERT, DELETE: catálogo global de solo lectura\)/);
  });
});

describe('esquemaObligatorio: cuándo un esquema atrasado impide arrancar', () => {
  test('en desarrollo no; en producción sí', () => {
    assert.equal(esquemaObligatorio({}), false);
    assert.equal(esquemaObligatorio({ NODE_ENV: 'development' }), false);
    assert.equal(esquemaObligatorio({ NODE_ENV: 'test' }), false);
    assert.equal(esquemaObligatorio({ NODE_ENV: 'production' }), true);
  });

  test('ALLOW_STALE_SCHEMA=1 es la única salida, y solo vale exacta', () => {
    assert.equal(esquemaObligatorio({ NODE_ENV: 'production', ALLOW_STALE_SCHEMA: '1' }), false);
    assert.equal(esquemaObligatorio({ NODE_ENV: 'production', ALLOW_STALE_SCHEMA: 'true' }), true);
    assert.equal(esquemaObligatorio({ NODE_ENV: 'production', ALLOW_STALE_SCHEMA: '' }), true);
  });
});
