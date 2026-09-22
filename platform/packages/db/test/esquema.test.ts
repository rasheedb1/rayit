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
  assertSchemaUpToDate, esquemaObligatorio, estadoDelEsquema, explicarEsquema, migracionesDelRepositorio,
  TABLAS_CON_RLS, type EstadoDelEsquema,
} from '../src/esquema.ts';
import { openTestDb, type TestDb } from './pglite.ts';

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

const AL_DIA: EstadoDelEsquema = {
  aplicadas: 20,
  ultima: '0020_x.sql',
  pendientes: [],
  sinRls: [],
  comparadoConArchivos: true,
};

describe('estadoDelEsquema contra una base recién migrada', () => {
  test('no falta ninguna migración y ninguna tabla se quedó sin RLS', async () => {
    const estado = await estadoDelEsquema(t.db);
    assert.equal(estado.comparadoConArchivos, true);
    assert.deepEqual(estado.pendientes, [], 'la base embebida aplica db/migrations con el mismo runner');
    assert.deepEqual(estado.sinRls, []);
    assert.equal(estado.aplicadas, (await migracionesDelRepositorio()).length);
    assert.equal(estado.ultima, (await migracionesDelRepositorio()).at(-1));
    assert.equal(explicarEsquema(estado), null);
  });

  test('la lista de tablas aisladas no está vacía: si lo estuviera, la comprobación no comprobaría nada', () => {
    assert.ok(TABLAS_CON_RLS.length > 40, `solo ${TABLAS_CON_RLS.length} tablas declaradas`);
    assert.ok(TABLAS_CON_RLS.includes('contact'));
    assert.ok(TABLAS_CON_RLS.includes('app_user'));
    assert.ok(TABLAS_CON_RLS.includes('quote_item'));
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

  test('con tablas sin RLS, explica qué significa: devuelven las filas de todos', () => {
    const msg = String(explicarEsquema({ ...AL_DIA, sinRls: ['membership', 'contact'] }));
    assert.match(msg, /membership, contact/);
    assert.match(msg, /todos los workspaces/i);
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
