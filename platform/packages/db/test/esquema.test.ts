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
  explicarEsquema, migracionesDelRepositorio, PRIVILEGIOS_DE_LA_APP, type EstadoDelEsquema,
} from '../src/esquema.ts';
import type { CatalogDb } from '../src/client.ts';
import { openTestDb, type TestDb } from './pglite.ts';

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

const AL_DIA: EstadoDelEsquema = { ...ESQUEMA_AL_DIA, aplicadas: 22, ultima: '0024_x.sql' };

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
    // silencio lo que la migración 0024 revocó.
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
    // La política tiene que AISLAR para que la excepción sobre: con un
    // `USING (true)` la tabla sigue sin aislar (ver la prueba de abajo),
    // así que aquí se le pone una de verdad.
    await t.admin(
      'ALTER TABLE platform ENABLE ROW LEVEL SECURITY; ALTER TABLE platform FORCE ROW LEVEL SECURITY; ' +
        // Una clave ajena a workspace(id) comparada con el inquilino
        // aísla (no tiene sentido para platform, pero la prueba es sobre
        // la lista, no sobre la tabla). Hasta la ronda 4 valía `id =
        // current_user_id()::text`, que compara con la persona una
        // columna que no nombra a ninguna: ya no cuenta (ronda 5).
        'ALTER TABLE platform ADD COLUMN zz_ws uuid REFERENCES workspace(id); ' +
        'CREATE POLICY platform_todo ON platform USING (zz_ws = current_workspace_id())',
    );
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.excepcionesObsoletas, ['platform']);
      assert.match(String(explicarEsquema(estado)), /sobran excepciones/);
    } finally {
      await t.admin(
        'DROP POLICY platform_todo ON platform; ALTER TABLE platform DROP COLUMN zz_ws; ' +
          'ALTER TABLE platform NO FORCE ROW LEVEL SECURITY; ALTER TABLE platform DISABLE ROW LEVEL SECURITY',
      );
    }
  });

  test('contar políticas no basta: una que dice `true` no aísla, y la guardia la nombra', async () => {
    // El agujero de la ronda 1: «aislada = ENABLE + FORCE + políticas >= 1».
    // Con ese criterio, una tabla nueva con `USING (true)` pasaba en
    // verde y desde el workspace B se leía la fila de A. Y el patrón
    // tenía un ejemplo vivo en el esquema (company_read, hasta 0024).
    await t.admin(
      'CREATE TABLE tabla_con_politica_true (id uuid PRIMARY KEY, workspace_id uuid); ' +
        'ALTER TABLE tabla_con_politica_true ENABLE ROW LEVEL SECURITY; ' +
        'ALTER TABLE tabla_con_politica_true FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY abierta ON tabla_con_politica_true USING (true) WITH CHECK (true); ' +
        // Como la crearía una migración: ALTER DEFAULT PRIVILEGES le da
        // los cuatro a mc_app. Sin privilegio, Postgres corta antes que
        // la política, y la guardia solo evalúa lo que mc_app puede hacer.
        'GRANT SELECT, INSERT, UPDATE, DELETE ON tabla_con_politica_true TO mc_app',
    );
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.sinRls, ['tabla_con_politica_true'], 'tiene RLS, FORCE y una política, y no aísla nada');
      assert.match(String(estado.sinAislar[0]?.falta), /no aíslan/);
      assert.deepEqual(
        estado.politicasAbiertas.map((p) => p.clave),
        ['tabla_con_politica_true.abierta'],
      );
      const msg = String(explicarEsquema(estado));
      assert.match(msg, /POLITICAS_ABIERTAS_DECLARADAS/);
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /tabla_con_politica_true/);
    } finally {
      await t.admin('DROP TABLE tabla_con_politica_true');
    }
  });

  test('las diez vistas corren con security_invoker: una nueva sin él se reporta', async () => {
    // En Postgres una vista es SECURITY DEFINER por omisión y lee sus
    // tablas base con los privilegios de su DUEÑO (mc_migrator), así
    // que rodea el muro de privilegios de la sección 7 de 0024.
    // Reproducido por los revisores: una vista sobre webhook_event
    // —donde mc_app no tiene NINGÚN privilegio— la deja leer, y la
    // guardia de la ronda 1 devolvía null.
    const alDia = await estadoDelEsquema(t.db);
    assert.deepEqual(alDia.vistasSinInvocador, [], '0024 §8 se lo pone a todas las que había');

    await t.admin('CREATE VIEW zz_webhooks AS SELECT * FROM webhook_event; GRANT SELECT ON zz_webhooks TO mc_app');
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.vistasSinInvocador, ['zz_webhooks']);
      const msg = String(explicarEsquema(estado));
      assert.match(msg, /security_invoker/);
      assert.match(msg, /zz_webhooks/);
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /zz_webhooks/);
    } finally {
      await t.admin('DROP VIEW zz_webhooks');
    }
  });

  test('y con security_invoker puesto, esa misma vista deja de reportarse', async () => {
    await t.admin(
      'CREATE VIEW zz_deals AS SELECT id, workspace_id FROM deal; ' +
        'ALTER VIEW zz_deals SET (security_invoker = on); GRANT SELECT ON zz_deals TO mc_app',
    );
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.vistasSinInvocador, []);
      assert.equal(explicarEsquema(estado), null, String(explicarEsquema(estado)));
    } finally {
      await t.admin('DROP VIEW zz_deals');
    }
  });

  test('una excepción declarada sin decir qué puede hacer mc_app con ella se reporta', () => {
    // El invariante estaba escrito en el comentario de
    // EXCEPCIONES_SIN_AISLAMIENTO y no lo comprobaba nadie: una
    // excepción nueva sin su entrada de privilegios nace sin RLS y con
    // los cuatro privilegios (ALTER DEFAULT PRIVILEGES se los da al
    // nacer), y las dos mitades de la guardia la dan por buena.
    const huerfanas = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter((t) => !(t in PRIVILEGIOS_DE_LA_APP));
    assert.deepEqual(huerfanas, [], 'hoy no hay ninguna, y la guardia lo vigila');
    const msg = String(explicarEsquema({ ...AL_DIA, excepcionesSinPrivilegios: ['tabla_huerfana'] }));
    assert.match(msg, /tabla_huerfana/);
    assert.match(msg, /PRIVILEGIOS_DE_LA_APP/);
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

/**
 * La guardia no falla ABIERTA.
 *
 * En la ronda 1, las consultas del inventario terminaban en
 * `.catch(() => [])`. Con la lista vacía todo lo demás sale vacío
 * —ninguna tabla sin aislar, ninguna excepción obsoleta, ningún
 * privilegio de más— y explicarEsquema devolvía null: el arranque daba
 * verde AFIRMANDO que toda tabla estaba aislada cuando lo que había
 * pasado es que no pudo preguntar. Basta un permiso que falte, un
 * statement_timeout o un pooler que corta, y en producción
 * assertSchemaUpToDate no lanzaba.
 */
describe('la guardia falla cerrada: si no pudo preguntar, lo dice', () => {
  /** Un CatalogDb de mentira: contesta a schema_migrations y se cae con la consulta que se le diga. */
  function dbQueSeCae(seCaeCon: RegExp, error: Error = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })): CatalogDb {
    const tx = {
      query: (sql: string) => {
        if (seCaeCon.test(sql)) return Promise.reject(error);
        return Promise.resolve({ rows: /schema_migrations/.test(sql) ? [{ filename: '0001_core.sql' }] : [] });
      },
    };
    return { withCatalogs: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as CatalogDb;
  }

  test('si pg_class no contesta, inventarioLeido queda en false y explicarEsquema lo dice', async () => {
    const estado = await estadoDelEsquema(dbQueSeCae(/pg_class/));
    assert.equal(estado.inventarioLeido, false);
    // Y todo lo demás está vacío porque no se pudo preguntar, no porque esté bien.
    assert.deepEqual(estado.sinAislar, []);
    assert.deepEqual(estado.privilegiosDeMas, []);
    const msg = String(explicarEsquema(estado));
    assert.match(msg, /no se pudo leer el inventario/);
    assert.match(msg, /la guardia no comprobó nada/);
  });

  test('y en producción eso no arranca, igual que con migraciones pendientes', async () => {
    await assert.rejects(
      assertSchemaUpToDate(dbQueSeCae(/pg_class/), { production: true }),
      /no se pudo leer el inventario/,
    );
  });

  test('lo mismo si la que se cae es la consulta de políticas', async () => {
    const estado = await estadoDelEsquema(dbQueSeCae(/pg_policy/));
    assert.equal(estado.inventarioLeido, false);
    assert.match(String(explicarEsquema(estado)), /no se pudo leer el inventario/);
  });

  test('lo mismo si la que se cae es la de privilegios', async () => {
    const estado = await estadoDelEsquema(dbQueSeCae(/aclexplode/));
    assert.equal(estado.inventarioLeido, false);
    assert.match(String(explicarEsquema(estado)), /no se pudo leer el inventario/);
  });

  test('lo mismo si la que se cae es la de disparadores, la de funciones o la de claves ajenas', async () => {
    for (const re of [/pg_trigger/, /pg_proc/, /pg_constraint/]) {
      const estado = await estadoDelEsquema(dbQueSeCae(re));
      assert.equal(estado.inventarioLeido, false, String(re));
    }
  });

  test('con la base CAÍDA no dice «nunca se migró» ni manda a migrar', async () => {
    // El log de producción de la ronda 2, con la base inalcanzable:
    // «la base no tiene schema_migrations: nunca se migró… Corre: make
    // db.migrate». aplicadas=-1 servía para «no existe la tabla» y para
    // «no hubo conexión», y quien opera iba a migrar una base que solo
    // estaba caída.
    const caida = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6543'), { code: 'ECONNREFUSED' });
    const estado = await estadoDelEsquema(dbQueSeCae(/./, caida));
    assert.equal(estado.inventarioLeido, false);
    const msg = String(explicarEsquema(estado));
    assert.doesNotMatch(msg, /nunca se migró/);
    assert.doesNotMatch(msg, /make db\.migrate/);
    assert.match(msg, /make db\.info/);
  });

  test('y sin la tabla (42P01) sí lo dice: esa base nunca se migró', async () => {
    // Drizzle y pg envuelven el error: el código se busca en la cadena de causas.
    const sinTabla = new Error('Failed query', {
      cause: Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' }),
    });
    const estado = await estadoDelEsquema(dbQueSeCae(/schema_migrations/, sinTabla));
    assert.equal(estado.inventarioLeido, true);
    assert.equal(estado.aplicadas, -1);
    const msg = String(explicarEsquema(estado));
    assert.match(msg, /nunca se migró/);
    assert.match(msg, /make db\.migrate/);
  });

  test('contra la base de verdad, en cambio, el inventario sí se lee', async () => {
    const estado = await estadoDelEsquema(t.db);
    assert.equal(estado.inventarioLeido, true);
  });
});

/**
 * RONDA 3: la misma clase —algo sin declarar pasa en verde—, una capa
 * más abajo en cada caso. Todos reproducidos por los revisores contra
 * pglite con estadoDelEsquema, y todos pasaban con la guardia de la
 * ronda 2.
 */
describe('ronda 3: la guardia evalúa cada política, cada objeto y cada referencia', () => {
  /** Mete `sql` como superusuario, pregunta, y deshace con `deshacer` pase lo que pase. */
  async function con<T>(sql: string, deshacer: string, fn: (estado: EstadoDelEsquema) => T | Promise<T>): Promise<T> {
    await t.admin(sql);
    try {
      return await fn(await estadoDelEsquema(t.db));
    } finally {
      await t.admin(deshacer);
    }
  }
  const claves = (e: EstadoDelEsquema) => e.politicasAbiertas.map((p) => p.clave);

  test('una política abierta JUNTO a una buena se reporta: las permisivas se combinan con OR', async () => {
    // (1) de los revisores: deal está aislada y `coladera` le abre la
    // lectura entera. La ronda 2 veía `deal_ws_isolation` y daba verde.
    await con('CREATE POLICY coladera ON deal FOR SELECT USING (1 = 1)', 'DROP POLICY coladera ON deal', (e) => {
      assert.ok(claves(e).includes('deal.coladera'));
      assert.match(String(e.sinAislar.find((x) => x.tabla === 'deal')?.falta), /coladera \[SELECT\] por «1 = 1»/);
    });
  });

  test('`current_workspace_id() IS NOT NULL` no aísla: vale para cualquier fila en cuanto hay workspace', async () => {
    // (2) de los revisores: mencionaba la función, y con eso bastaba.
    await con(
      'CREATE POLICY cualquiera ON quote USING (current_workspace_id() IS NOT NULL)',
      'DROP POLICY cualquiera ON quote',
      (e) => {
        const p = e.politicasAbiertas.find((x) => x.clave === 'quote.cualquiera');
        assert.deepEqual(p?.comandos, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        assert.equal(p?.trozo, 'current_workspace_id() IS NOT NULL');
      },
    );
  });

  test('un FOR DELETE abierto sobre una tabla con la lectura aislada se reporta, por su comando', async () => {
    // (3) de los revisores: B no LEÍA las facturas de A, pero las BORRABA.
    await con(
      'CREATE POLICY borra_todo ON invoice FOR DELETE USING (workspace_id IS NOT NULL)',
      'DROP POLICY borra_todo ON invoice',
      (e) => {
        const p = e.politicasAbiertas.find((x) => x.clave === 'invoice.borra_todo');
        assert.deepEqual(p?.comandos, ['DELETE']);
        assert.ok(e.sinRls.includes('invoice'));
      },
    );
  });

  test('un EXISTS sin tabla, o sin correlación con la fila, no aísla', async () => {
    await con(
      'CREATE POLICY siempre ON expense FOR SELECT USING (EXISTS (SELECT 1)); ' +
        'CREATE POLICY si_tengo_alguno ON payment FOR SELECT USING (EXISTS (SELECT 1 FROM deal d))',
      'DROP POLICY siempre ON expense; DROP POLICY si_tengo_alguno ON payment',
      (e) => {
        assert.ok(claves(e).includes('expense.siempre'));
        assert.ok(claves(e).includes('payment.si_tengo_alguno'), '«¿tengo algún deal?» abre la tabla entera a quien tenga uno');
      },
    );
  });

  test('una política abierta CONTAGIA a las hijas que miran a su padre con EXISTS', async () => {
    // quote_item se aísla preguntando por su quote: si la quote está
    // abierta, sus precios también. La guardia lo dice en las dos.
    await con('CREATE POLICY coladera ON quote FOR SELECT USING (true)', 'DROP POLICY coladera ON quote', (e) => {
      assert.ok(claves(e).includes('quote.coladera'));
      assert.ok(claves(e).includes('quote_item.quote_item_ws_isolation'));
    });
  });

  test('«sin dueño, o mío» vale para LEER, no para escribir', async () => {
    // La rama `workspace_id IS NULL` es la fila global de un catálogo
    // con dueño (pipeline_stage). En un UPDATE deja tocar las de todos.
    await con(
      'CREATE POLICY toca_globales ON pipeline_stage FOR UPDATE ' +
        'USING (workspace_id IS NULL OR workspace_id = current_workspace_id())',
      'DROP POLICY toca_globales ON pipeline_stage',
      (e) => {
        const p = e.politicasAbiertas.find((x) => x.clave === 'pipeline_stage.toca_globales');
        assert.deepEqual(p?.comandos, ['UPDATE']);
        assert.equal(p?.trozo, 'workspace_id IS NULL');
      },
    );
  });

  test('una política que no alcanza a mc_app (TO otro rol) no le abre nada', async () => {
    // Así deja 0025 §4 las altas de los seeds: TO el rol que migra.
    await con(
      'CREATE POLICY solo_migrador ON deal FOR SELECT TO mc_migrator_embedded USING (true)',
      'DROP POLICY solo_migrador ON deal',
      (e) => assert.ok(!claves(e).includes('deal.solo_migrador')),
    );
  });

  test('una restrictiva que aísla cierra el comando aunque haya una permisiva abierta', async () => {
    await con(
      'CREATE POLICY abierta ON expense FOR SELECT USING (true); ' +
        'CREATE POLICY candado ON expense AS RESTRICTIVE FOR SELECT USING (workspace_id = current_workspace_id())',
      'DROP POLICY abierta ON expense; DROP POLICY candado ON expense',
      (e) => assert.ok(!claves(e).includes('expense.abierta')),
    );
  });

  test('una vista materializada sobre webhook_event: mc_app la lee, y la guardia la nombra', async () => {
    // (4) y (7) de los revisores. Una materializada no admite RLS, guarda
    // lo que vio quien la refrescó y ALTER DEFAULT PRIVILEGES le da
    // SELECT a mc_app al nacer: las cabeceras con firmas de webhook_event
    // —donde mc_app no tiene NINGÚN privilegio— salían por aquí.
    await t.admin(
      "INSERT INTO webhook_event (provider, payload, headers) VALUES ('tiktok', '{}', '{\"x-signature\": \"abc\"}'); " +
        'SET ROLE mc_migrator_embedded; CREATE MATERIALIZED VIEW zz_mv_webhooks AS SELECT * FROM webhook_event; RESET ROLE',
    );
    try {
      const { rows } = await t.db.withWorkspace('0000000a-0000-4000-8000-0000000000aa', (tx) =>
        tx.query<{ headers: unknown }>('SELECT headers FROM zz_mv_webhooks'),
      );
      assert.deepEqual(rows[0]?.headers, { 'x-signature': 'abc' }, 'la prueba no vale si mc_app no llega a leerla');
      const e = await estadoDelEsquema(t.db);
      assert.deepEqual(e.relacionesSinRls, ['zz_mv_webhooks (vista materializada)']);
      assert.match(String(explicarEsquema(e)), /RELACIONES_SIN_RLS_DECLARADAS/);
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /zz_mv_webhooks/);
    } finally {
      await t.admin('DROP MATERIALIZED VIEW zz_mv_webhooks; DELETE FROM webhook_event');
    }
  });

  test('una función SECURITY DEFINER que mc_app puede llamar se nombra', async () => {
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE FUNCTION zz_lee_webhooks() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$SELECT count(*) FROM webhook_event$$; ' +
        'RESET ROLE',
      'DROP FUNCTION zz_lee_webhooks()',
      (e) => {
        assert.deepEqual(e.funcionesDefiner, ['zz_lee_webhooks()']);
        assert.match(String(explicarEsquema(e)), /FUNCIONES_DEFINER_DECLARADAS/);
      },
    );
  });

  test('TRUNCATE, TRIGGER y REFERENCES no los tiene mc_app en ninguna parte: TRUNCATE se salta la RLS', async () => {
    await con('GRANT TRUNCATE, TRIGGER ON deal TO mc_app', 'REVOKE TRUNCATE, TRIGGER ON deal FROM mc_app', (e) => {
      const deal = e.privilegiosDeMas.find((p) => p.tabla === 'deal');
      assert.deepEqual(deal?.privilegios, ['TRUNCATE', 'TRIGGER']);
      assert.match(String(explicarEsquema(e)), /TRUNCATE se salta la RLS/);
    });
  });

  test('ningún otro rol —PUBLIC incluido— tiene privilegios sobre public sin declararlo', async () => {
    // En Supabase, PostgREST expone anon y authenticated a internet: un
    // GRANT a cualquiera de los dos sobre una excepción sin RLS es la
    // tabla entera, y sobre contact los contactos públicos del catálogo.
    await con(
      'CREATE ROLE zz_anon NOLOGIN; GRANT SELECT ON webhook_event TO zz_anon; GRANT SELECT ON niche TO PUBLIC',
      'REVOKE SELECT ON webhook_event FROM zz_anon; REVOKE SELECT ON niche FROM PUBLIC; DROP ROLE zz_anon',
      (e) => {
        assert.deepEqual(e.rolesDeMas.map((r) => `${r.rol}:${r.tabla}`).sort(), ['PUBLIC:niche', 'zz_anon:webhook_event']);
        assert.match(String(explicarEsquema(e)), /ROLES_CON_ACCESO_DECLARADOS/);
      },
    );
  });

  /** Una tabla de inquilino nueva, como la crearía una migración, con una clave hacia deal. */
  const TABLA_NUEVA =
    'SET ROLE mc_migrator_embedded; ' +
    'CREATE TABLE zz_nota (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspace(id), deal_id uuid REFERENCES deal(id)); ' +
    'ALTER TABLE zz_nota ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_nota FORCE ROW LEVEL SECURITY; ' +
    'CREATE POLICY zz_nota_ws ON zz_nota USING (workspace_id = current_workspace_id()); ';

  test('una clave ajena hacia una tabla con RLS sin assert_reference_visible se nombra', async () => {
    // La clave ajena no pasa por RLS: sin el disparador de 0025 §3, una
    // fila de B puede nombrar el deal de A si conoce su id.
    await con(TABLA_NUEVA + 'RESET ROLE', 'DROP TABLE zz_nota', (e) => {
      assert.deepEqual(e.referenciasSinComprobar, ['zz_nota.deal_id → deal', 'zz_nota.workspace_id → workspace']);
      assert.match(String(explicarEsquema(e)), /assert_reference_visible/);
    });
  });

  test('y con el disparador puesto, esa misma clave deja de reportarse', async () => {
    await con(
      TABLA_NUEVA +
        'CREATE TRIGGER ref_visible_deal_id BEFORE INSERT OR UPDATE OF deal_id ON zz_nota FOR EACH ROW ' +
        "WHEN (NEW.deal_id IS NOT NULL) EXECUTE FUNCTION assert_reference_visible('deal_id', 'deal', 'id'); " +
        'CREATE TRIGGER ref_visible_workspace_id BEFORE INSERT OR UPDATE OF workspace_id ON zz_nota FOR EACH ROW ' +
        "EXECUTE FUNCTION assert_reference_visible('workspace_id', 'workspace', 'id'); " +
        'RESET ROLE',
      'DROP TABLE zz_nota',
      (e) => {
        assert.deepEqual(e.referenciasSinComprobar, []);
        assert.equal(explicarEsquema(e), null, String(explicarEsquema(e)));
      },
    );
  });

  test('un disparador DESHABILITADO no cuenta', async () => {
    await con(
      'ALTER TABLE deal DISABLE TRIGGER ref_visible_company_id',
      'ALTER TABLE deal ENABLE TRIGGER ref_visible_company_id',
      (e) => assert.deepEqual(e.referenciasSinComprobar, ['deal.company_id → company']),
    );
  });
});

/**
 * RONDA 4: la misma clase otra vez, en lo que la guardia de la ronda 3
 * todavía no miraba. Cada caso lo reprodujeron los revisores contra
 * pglite con la guardia en verde.
 */
describe('ronda 4: columnas, correlaciones, padres con globales, índices únicos y secuencias', () => {
  async function con<T>(sql: string, deshacer: string, fn: (estado: EstadoDelEsquema) => T | Promise<T>): Promise<T> {
    await t.admin(sql);
    try {
      return await fn(await estadoDelEsquema(t.db));
    } finally {
      await t.admin(deshacer);
    }
  }
  const claves = (e: EstadoDelEsquema) => e.politicasAbiertas.map((p) => p.clave);
  const WS = '0000004a-0000-4000-8000-000000000001';

  test('un GRANT POR COLUMNA sobre un catálogo se reporta: un REVOKE de tabla no lo quita', async () => {
    // El guion de los revisores: `GRANT UPDATE (slug) ON niche TO mc_app`
    // dejaba la guardia en verde, y desde withWorkspace mc_app
    // actualizaba todas las filas de niche, que 0024 §7.1 dejó de solo
    // lectura.
    await t.admin("INSERT INTO niche (slug, name_es) VALUES ('zz-nicho', 'Nicho de prueba'); GRANT UPDATE (slug) ON niche TO mc_app");
    try {
      const { rows } = await t.db.withWorkspace(WS, (tx) => tx.query('UPDATE niche SET slug = slug RETURNING slug'));
      assert.ok(rows.length > 0, 'la prueba no vale si mc_app no llega a escribir el catálogo');
      const e = await estadoDelEsquema(t.db);
      const niche = e.privilegiosDeMas.find((p) => p.tabla === 'niche');
      assert.deepEqual(niche?.privilegios, ['UPDATE']);
      assert.match(String(niche?.motivo), /POR COLUMNA \(slug\)/);
      await assert.rejects(assertSchemaUpToDate(t.db, { production: true }), /niche \(UPDATE/);
    } finally {
      await t.admin("REVOKE UPDATE (slug) ON niche FROM mc_app; DELETE FROM niche WHERE slug = 'zz-nicho'");
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).privilegiosDeMas, []);
  });

  test('un GRANT por columna a otro rol también se nombra', async () => {
    await con(
      'CREATE ROLE zz_col NOLOGIN; GRANT SELECT (email) ON app_user TO zz_col',
      'REVOKE SELECT (email) ON app_user FROM zz_col; DROP ROLE zz_col',
      (e) => assert.deepEqual(e.rolesDeMas.map((r) => `${r.rol}:${r.tabla}`), ['zz_col:app_user']),
    );
  });

  test('un EXISTS correlacionado por una columna cualquiera no aísla: tiene que ser una clave ajena', async () => {
    // El guion de los revisores: `d.name = zz_corr.nota` pasaba en verde,
    // y B leía toda fila de A cuya nota coincidiera con el nombre de un
    // deal suyo. Lo mismo con membership.user_id = t.created_by, que
    // abre las filas de otros workspaces de una persona compartida.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_corr (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text); ' +
        'ALTER TABLE zz_corr ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_corr FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_corr_p ON zz_corr FOR SELECT USING (EXISTS (SELECT 1 FROM deal d WHERE d.name = zz_corr.nota)); ' +
        'CREATE TABLE zz_corr_persona (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid REFERENCES app_user(id)); ' +
        'ALTER TABLE zz_corr_persona ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_corr_persona FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_corr_persona_p ON zz_corr_persona FOR SELECT ' +
        '  USING (EXISTS (SELECT 1 FROM membership m WHERE m.user_id = zz_corr_persona.created_by)); ' +
        // El control: la misma forma, por una clave ajena de verdad, sí aísla.
        'CREATE TABLE zz_corr_deal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid REFERENCES deal(id)); ' +
        'ALTER TABLE zz_corr_deal ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_corr_deal FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_corr_deal_p ON zz_corr_deal FOR SELECT USING (EXISTS (SELECT 1 FROM deal d WHERE d.id = zz_corr_deal.deal_id)); ' +
        'REVOKE ALL ON zz_corr, zz_corr_persona, zz_corr_deal FROM mc_app; ' +
        'GRANT SELECT ON zz_corr, zz_corr_persona, zz_corr_deal TO mc_app; RESET ROLE',
      'DROP TABLE zz_corr, zz_corr_persona, zz_corr_deal',
      (e) => {
        assert.ok(claves(e).includes('zz_corr.zz_corr_p'), JSON.stringify(claves(e)));
        assert.ok(claves(e).includes('zz_corr_persona.zz_corr_persona_p'));
        assert.ok(!claves(e).includes('zz_corr_deal.zz_corr_deal_p'), 'por una clave ajena real, sí aísla');
      },
    );
  });

  test('un EXISTS sobre un padre con filas globales no aísla una fila que tiene inquilino propio', async () => {
    // El guion de los revisores: zz con workspace_id y stage_id, y una
    // política que solo pregunta por la etapa. Toda fila que apunte a una
    // etapa GLOBAL la leía cualquier workspace, aunque fuera de A.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_etapa (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspace(id), ' +
        '  stage_id text REFERENCES pipeline_stage(id)); ' +
        'ALTER TABLE zz_etapa ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_etapa FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_etapa_p ON zz_etapa FOR SELECT USING (EXISTS (SELECT 1 FROM pipeline_stage d WHERE d.id = zz_etapa.stage_id)); ' +
        // Con el inquilino en un AND, la misma política aísla.
        'CREATE TABLE zz_etapa_ok (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspace(id), ' +
        '  stage_id text REFERENCES pipeline_stage(id)); ' +
        'ALTER TABLE zz_etapa_ok ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_etapa_ok FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_etapa_ok_p ON zz_etapa_ok FOR SELECT USING (workspace_id = current_workspace_id() ' +
        '  AND EXISTS (SELECT 1 FROM pipeline_stage d WHERE d.id = zz_etapa_ok.stage_id)); ' +
        // Y una hija SIN inquilino propio hereda las globales, como external_post_score.
        'CREATE TABLE zz_etapa_global (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_id text REFERENCES pipeline_stage(id)); ' +
        'ALTER TABLE zz_etapa_global ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_etapa_global FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_etapa_global_p ON zz_etapa_global FOR SELECT ' +
        '  USING (EXISTS (SELECT 1 FROM pipeline_stage d WHERE d.id = zz_etapa_global.stage_id)); ' +
        'REVOKE ALL ON zz_etapa, zz_etapa_ok, zz_etapa_global FROM mc_app; ' +
        'GRANT SELECT ON zz_etapa, zz_etapa_ok, zz_etapa_global TO mc_app; RESET ROLE',
      'DROP TABLE zz_etapa, zz_etapa_ok, zz_etapa_global',
      (e) => {
        assert.ok(claves(e).includes('zz_etapa.zz_etapa_p'), JSON.stringify(claves(e)));
        assert.ok(!claves(e).includes('zz_etapa_ok.zz_etapa_ok_p'));
        assert.ok(!claves(e).includes('zz_etapa_global.zz_etapa_global_p'));
      },
    );
  });

  test('un índice único global sobre una tabla con dueño se nombra; por inquilino, o solo sobre las filas sin dueño, no', async () => {
    // contact_email_idx era esto: B chocaba con el correo de un contacto
    // de A (23505) y aprendía que otra agencia tiene a esa persona.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_u (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, codigo text, otro text, tercero text); ' +
        'ALTER TABLE zz_u ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_u FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_u_ws ON zz_u USING (workspace_id = current_workspace_id()); ' +
        'CREATE UNIQUE INDEX zz_u_global ON zz_u (codigo); ' +
        'CREATE UNIQUE INDEX zz_u_por_ws ON zz_u (workspace_id, otro); ' +
        'CREATE UNIQUE INDEX zz_u_catalogo ON zz_u (tercero) WHERE workspace_id IS NULL; ' +
        'CREATE UNIQUE INDEX zz_u_expresion ON zz_u (lower(tercero)); ' +
        'RESET ROLE',
      'DROP TABLE zz_u',
      (e) => {
        assert.deepEqual(e.unicosSinInquilino, ['zz_u.zz_u_expresion (lower(tercero))', 'zz_u.zz_u_global (codigo)']);
        const msg = String(explicarEsquema(e));
        assert.match(msg, /UNICOS_GLOBALES_DECLARADOS/);
        assert.match(msg, /zz_u\.zz_u_global/);
      },
    );
  });

  test('las secuencias: SELECT de más se reporta, y una secuencia nueva sin tabla también', async () => {
    // Desde B, `SELECT last_value FROM account_metric_snapshot_id_seq`
    // devolvía el volumen de toda la plataforma. 0026 §4 quita SELECT y
    // UPDATE, y deja USAGE solo donde mc_app inserta.
    await con(
      'GRANT SELECT ON audit_log_id_seq TO mc_app; ' +
        'SET ROLE mc_migrator_embedded; CREATE SEQUENCE zz_seq; RESET ROLE',
      'REVOKE SELECT ON audit_log_id_seq FROM mc_app; DROP SEQUENCE zz_seq',
      (e) => {
        const audit = e.privilegiosDeMas.find((p) => p.tabla === 'audit_log_id_seq');
        assert.deepEqual(audit?.privilegios, ['SELECT']);
        const suelta = e.privilegiosDeMas.find((p) => p.tabla === 'zz_seq');
        assert.deepEqual(suelta?.privilegios, ['USAGE'], 'los privilegios por defecto ya no le dan SELECT, pero USAGE sobra');
        assert.match(String(suelta?.motivo), /sin tabla/);
      },
    );
  });

  test('contra la base como estaba en 0025, la guardia nombra lo que 0026 cierra', async (ctx) => {
    // Es la prueba de que la guardia ve la clase y no solo los casos: sin
    // tocarla, contra el esquema real anterior a 0026, dice los dos
    // únicos globales y las secuencias que los revisores encontraron. (La
    // clave de pipeline_stage no sale porque está declarada: su motivo es
    // el CHECK que pone 0026 §2.)
    if (t.kind !== 'pglite') return ctx.skip('reconstruir una base a medio migrar solo se puede sobre pglite');
    const { createEmbeddedDb } = await import('../src/embedded.ts');
    const antes = await createEmbeddedDb({ seeds: false, hasta: '0025_referencias_visibles.sql' });
    try {
      const e = await estadoDelEsquema(antes);
      assert.deepEqual(e.unicosSinInquilino, [
        'contact.contact_email_idx (email)',
        'video_asset.video_asset_content_hash_idx (content_hash)',
      ]);
      const secuencias = e.privilegiosDeMas.filter((p) => p.tabla.endsWith('_seq') && p.privilegios.includes('SELECT'));
      assert.ok(secuencias.some((p) => p.tabla === 'account_metric_snapshot_id_seq'));
      assert.ok(secuencias.length >= 10, `solo ${secuencias.length} secuencias con SELECT`);
    } finally {
      await antes.close();
    }
  });
});

/**
 * RONDA 5: lo que corre con los privilegios de OTRO sin pasar por un
 * GRANT —disparadores, reglas, otros esquemas, el propio rol—, y lo que
 * la forma de una política no decía —la lista del EXISTS, qué columna
 * se compara, a qué apunta la fila global y qué pasa al borrar su
 * padre—. Cada caso es el guion de un revisor, y cada uno pasaba en
 * verde con la guardia de la ronda 4.
 */
describe('ronda 5: disparadores, reglas, esquemas, el rol de la app y lo que nombra una fila global', () => {
  async function con<T>(sql: string, deshacer: string, fn: (estado: EstadoDelEsquema) => T | Promise<T>): Promise<T> {
    await t.admin(sql);
    try {
      return await fn(await estadoDelEsquema(t.db));
    } finally {
      await t.admin(deshacer);
    }
  }
  const claves = (e: EstadoDelEsquema) => e.politicasAbiertas.map((p) => p.clave);
  const WS = '0000005a-0000-4000-8000-000000000001';
  const OTRO_WS = '0000005b-0000-4000-8000-000000000001';

  before(async () => {
    await t.admin(
      `INSERT INTO workspace (id, slug, name) VALUES ('${WS}', 'ronda-5', 'Ronda 5'); ` +
        "INSERT INTO niche (slug, name_es) VALUES ('zz-niche', 'Nicho intacto')",
    );
  });
  after(async () => {
    await t.admin(`DELETE FROM workspace WHERE id = '${WS}'; DELETE FROM niche WHERE slug = 'zz-niche'`);
  });

  /** El nombre del nicho de prueba: es un catálogo, así que se lee sin workspace. */
  const nicho = async () => {
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ name_es: string }>("SELECT name_es FROM niche WHERE slug = 'zz-niche'"),
    );
    return rows[0]?.name_es;
  };

  test('un EXISTS con un agregado en la lista es verdadero para toda fila, y la guardia lo nombra', async () => {
    // El guion de los revisores: `SELECT count(*)` sin GROUP BY devuelve
    // siempre una fila. Con la ronda 4, sinAislar=[] y politicasAbiertas=[].
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_b (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid REFERENCES deal(id), nota text); ' +
        'ALTER TABLE zz_b ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_b FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_b_p ON zz_b FOR SELECT USING (EXISTS (SELECT count(*) FROM deal d WHERE d.id = zz_b.deal_id)); ' +
        // Las demás formas que cambian cuántas filas devuelve la subconsulta.
        'CREATE TABLE zz_b2 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid REFERENCES deal(id)); ' +
        'ALTER TABLE zz_b2 ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_b2 FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_b2_having ON zz_b2 FOR SELECT ' +
        '  USING (EXISTS (SELECT 1 FROM deal d WHERE d.id = zz_b2.deal_id HAVING true)); ' +
        'CREATE POLICY zz_b2_union ON zz_b2 FOR SELECT ' +
        '  USING (EXISTS (SELECT 1 FROM deal d WHERE d.id = zz_b2.deal_id UNION SELECT 1)); ' +
        'REVOKE ALL ON zz_b, zz_b2 FROM mc_app; GRANT SELECT ON zz_b, zz_b2 TO mc_app; RESET ROLE; ' +
        "INSERT INTO zz_b (nota) VALUES ('de A'), ('de A'), ('de A')",
      'DROP TABLE zz_b, zz_b2',
      async (e) => {
        const { rows } = await t.db.withWorkspace(WS, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM zz_b'));
        assert.equal(rows[0]?.n, 3, 'la prueba no vale si la política no abre la tabla');
        assert.ok(claves(e).includes('zz_b.zz_b_p'), JSON.stringify(claves(e)));
        assert.ok(claves(e).includes('zz_b2.zz_b2_having'));
        assert.ok(claves(e).includes('zz_b2.zz_b2_union'));
      },
    );
  });

  test('comparar con el inquilino una columna que no es la del inquilino no aísla', async () => {
    // `(nota)::uuid = current_workspace_id()` y `created_by =
    // current_user_id()` en una tabla con workspace_id: el primero deja a
    // B leer la fila de A con la nota de B; el segundo abre a quien está
    // en dos workspaces las filas del otro. Con el inquilino en un AND, la
    // persona sí vale.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_col (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspace(id), ' +
        '  nota text, created_by uuid REFERENCES app_user(id)); ' +
        'ALTER TABLE zz_col ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_col FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_col_nota ON zz_col FOR SELECT USING ((nota)::uuid = current_workspace_id()); ' +
        'CREATE POLICY zz_col_persona ON zz_col FOR SELECT USING (created_by = current_user_id()); ' +
        'CREATE POLICY zz_col_ambos ON zz_col FOR SELECT ' +
        '  USING (workspace_id = current_workspace_id() AND created_by = current_user_id()); ' +
        'REVOKE ALL ON zz_col FROM mc_app; GRANT SELECT ON zz_col TO mc_app; RESET ROLE; ' +
        `INSERT INTO zz_col (workspace_id, nota) VALUES ('${WS}', '${OTRO_WS}')`,
      'DROP TABLE zz_col',
      async (e) => {
        const { rows } = await t.db.withWorkspace(OTRO_WS, (tx) =>
          tx.query<{ n: number }>('SELECT count(*)::int AS n FROM zz_col'),
        );
        assert.equal(rows[0]?.n, 1, 'desde B se lee la fila de A: la prueba no vale si no');
        assert.ok(claves(e).includes('zz_col.zz_col_nota'), JSON.stringify(claves(e)));
        assert.ok(claves(e).includes('zz_col.zz_col_persona'));
        assert.ok(!claves(e).includes('zz_col.zz_col_ambos'), 'con el inquilino en un AND, aísla');
      },
    );
  });

  test('una fila global que nombra una privada por otra clave ajena no aísla; correlacionada, sí', async () => {
    // brand_account_snapshot hasta 0029: `campaign_id IS NULL OR EXISTS
    // (campaign)` abría a todos company_id, handle y seguidores de
    // empresas privadas. La guardia aceptaba la rama porque `IS NULL` era
    // la columna de la otra rama.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_snap (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES campaign(id), ' +
        '  company_id uuid NOT NULL REFERENCES company(id)); ' +
        'ALTER TABLE zz_snap ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_snap FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_snap_p ON zz_snap FOR SELECT ' +
        '  USING (campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign p WHERE p.id = zz_snap.campaign_id)); ' +
        'CREATE TABLE zz_snap_ok (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES campaign(id), ' +
        '  company_id uuid NOT NULL REFERENCES company(id)); ' +
        'ALTER TABLE zz_snap_ok ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_snap_ok FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_snap_ok_p ON zz_snap_ok FOR SELECT ' +
        '  USING ((campaign_id IS NULL AND EXISTS (SELECT 1 FROM company c WHERE c.id = zz_snap_ok.company_id)) ' +
        '    OR EXISTS (SELECT 1 FROM campaign p WHERE p.id = zz_snap_ok.campaign_id)); ' +
        'REVOKE ALL ON zz_snap, zz_snap_ok FROM mc_app; GRANT SELECT ON zz_snap, zz_snap_ok TO mc_app; RESET ROLE',
      'DROP TABLE zz_snap, zz_snap_ok',
      (e) => {
        const p = e.politicasAbiertas.find((x) => x.clave === 'zz_snap.zz_snap_p');
        assert.match(String(p?.trozo), /company_id → company/);
        assert.ok(!claves(e).includes('zz_snap_ok.zz_snap_ok_p'), JSON.stringify(claves(e)));
      },
    );
  });

  test('ON DELETE SET NULL sobre la columna de una rama «IS NULL»: borrar el padre publica la fila', async () => {
    // company.owner_workspace_id hasta 0029: se borraba el workspace C y
    // su «Prospecto secreto» pasaba al catálogo de todos.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE TABLE zz_marca (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ' +
        '  owner_workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL); ' +
        'ALTER TABLE zz_marca ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_marca FORCE ROW LEVEL SECURITY; ' +
        'CREATE POLICY zz_marca_read ON zz_marca FOR SELECT ' +
        '  USING (owner_workspace_id IS NULL OR owner_workspace_id = current_workspace_id()); ' +
        'REVOKE ALL ON zz_marca FROM mc_app; GRANT SELECT ON zz_marca TO mc_app; RESET ROLE',
      'DROP TABLE zz_marca',
      (e) => {
        assert.deepEqual(e.borradosQuePublican, ['zz_marca.owner_workspace_id → workspace (ON DELETE SET NULL)']);
        assert.match(String(explicarEsquema(e)), /BORRADOS_QUE_PUBLICAN_DECLARADOS/);
      },
    );
  });

  test('un disparador SECURITY DEFINER con EXECUTE revocado reescribe un catálogo, y la guardia lo nombra', async () => {
    // El guion de los revisores, tal cual: UPDATE niche falla con
    // permission denied, pero INSERT INTO company deja niche reescrito,
    // porque Postgres no mira EXECUTE al disparar.
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        'CREATE FUNCTION zz_fuga() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS ' +
        "$$BEGIN UPDATE niche SET name_es = 'PWN' WHERE slug = 'zz-niche'; RETURN NEW; END$$; " +
        'REVOKE EXECUTE ON FUNCTION zz_fuga() FROM PUBLIC, mc_app; ' +
        'CREATE TRIGGER zz_fuga AFTER INSERT ON company FOR EACH ROW EXECUTE FUNCTION zz_fuga(); RESET ROLE',
      'DROP TRIGGER zz_fuga ON company; DROP FUNCTION zz_fuga(); ' +
        "UPDATE niche SET name_es = 'Nicho intacto' WHERE slug = 'zz-niche'",
      async (e) => {
        await assert.rejects(
          t.db.withWorkspace(WS, (tx) => tx.query("UPDATE niche SET name_es = 'directo'")),
          /permission denied/,
        );
        await t.db.withWorkspace(WS, (tx) => tx.query("INSERT INTO company (name) VALUES ('Disparadora')"));
        assert.equal(await nicho(), 'PWN', 'la prueba no vale si el disparador no rodea el privilegio');
        assert.deepEqual(e.funcionesDefiner, ['zz_fuga()']);
        assert.deepEqual(e.disparadoresDefiner, ['company.zz_fuga → zz_fuga()']);
        const msg = String(explicarEsquema(e));
        assert.match(msg, /DISPARADORES_DEFINER_DECLARADOS/);
        assert.match(msg, /no mira EXECUTE/);
      },
    );
  });

  test('una regla sobre una tabla aislada reescribe un catálogo, y la guardia la nombra', async () => {
    await con(
      'SET ROLE mc_migrator_embedded; ' +
        "CREATE RULE zz_rule AS ON INSERT TO company DO ALSO UPDATE niche SET name_es = 'RULE' WHERE slug = 'zz-niche'; " +
        'RESET ROLE',
      "DROP RULE zz_rule ON company; UPDATE niche SET name_es = 'Nicho intacto' WHERE slug = 'zz-niche'",
      async (e) => {
        await t.db.withWorkspace(WS, (tx) => tx.query("INSERT INTO company (name) VALUES ('Reglada')"));
        assert.equal(await nicho(), 'RULE', 'la prueba no vale si la regla no rodea el privilegio');
        assert.deepEqual(e.reglas, ['company.zz_rule']);
        assert.match(String(explicarEsquema(e)), /REGLAS_DECLARADAS/);
      },
    );
  });

  test('un esquema fuera de public al que llega mc_app se nombra, y CREATE en public también', async () => {
    await con(
      'CREATE SCHEMA zz_otro; CREATE TABLE zz_otro.secretos (x text); ' +
        'GRANT USAGE ON SCHEMA zz_otro TO mc_app; GRANT ALL ON zz_otro.secretos TO mc_app; ' +
        'GRANT CREATE ON SCHEMA public TO mc_app',
      'DROP SCHEMA zz_otro CASCADE; REVOKE CREATE ON SCHEMA public FROM mc_app',
      (e) => {
        assert.deepEqual(e.esquemasDeMas.map((x) => x.split(' ')[0]).sort(), ['public', 'zz_otro']);
        assert.match(String(explicarEsquema(e)), /ESQUEMAS_DECLARADOS/);
      },
    );
  });

  test('mc_app miembro de mc_worker hereda BYPASSRLS por SET ROLE, y la guardia lo dice con su nombre', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('los roles de una base real no se tocan desde una prueba');
    await t.admin("INSERT INTO webhook_event (provider, payload, headers) VALUES ('tiktok', '{}', '{}')");
    await con('GRANT mc_worker TO mc_app', 'REVOKE mc_worker FROM mc_app; DELETE FROM webhook_event', async (e) => {
      const { rows } = await t.db.withWorkspace(WS, async (tx) => {
        await tx.query('SET LOCAL ROLE mc_worker');
        return tx.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_event');
      });
      assert.equal(rows[0]?.n, 1, 'la prueba no vale si mc_app no llega a leer lo que no tiene concedido');
      assert.equal(e.rolDeLaApp.length, 1, JSON.stringify(e.rolDeLaApp));
      assert.match(e.rolDeLaApp[0]!, /mc_app es miembro de mc_worker \(BYPASSRLS\)/);
      assert.match(String(explicarEsquema(e)), /ROLES_DE_LA_APP_DECLARADOS/);
    });
  });

  test('y mc_app con BYPASSRLS también se nombra, aunque sus GRANT no cambien', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('los roles de una base real no se tocan desde una prueba');
    await con('ALTER ROLE mc_app BYPASSRLS', 'ALTER ROLE mc_app NOBYPASSRLS', (e) => {
      assert.deepEqual(e.rolDeLaApp, ['mc_app tiene BYPASSRLS']);
    });
  });

  test('contra la base como estaba en 0026, la guardia nombra lo que 0029 cierra', async (ctx) => {
    // La prueba de que la guardia ve la CLASE: sin tocarla, contra el
    // esquema real anterior a 0029, dice los hallazgos de los revisores
    // (la supresión, brand_account_snapshot, company) y los dos que nadie
    // había nombrado (contact_read y external_post.analysis_id).
    if (t.kind !== 'pglite') return ctx.skip('reconstruir una base a medio migrar solo se puede sobre pglite');
    const { createEmbeddedDb } = await import('../src/embedded.ts');
    const antes = await createEmbeddedDb({ seeds: false, hasta: '0026_duenos_unicos_secuencias.sql' });
    try {
      const e = await estadoDelEsquema(antes);
      assert.deepEqual(e.funcionesDefiner, ['contact_suppression_record()']);
      assert.deepEqual(e.disparadoresDefiner, ['contact.contact_suppression_record → contact_suppression_record()']);
      assert.deepEqual(e.borradosQuePublican, [
        'company.owner_workspace_id → workspace (ON DELETE SET NULL)',
        'external_post.analysis_id → video_analysis (ON DELETE SET NULL)',
      ]);
      const abiertas = e.politicasAbiertas.map((p) => p.clave).sort();
      assert.deepEqual(abiertas, ['brand_account_snapshot.brand_account_snapshot_ws_isolation', 'contact.contact_read']);
    } finally {
      await antes.close();
    }
  });
});
