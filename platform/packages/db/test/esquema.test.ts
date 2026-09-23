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
        // `id = current_user_id()::text` compara una columna con la
        // persona de la transacción: aísla (no tiene sentido para
        // platform, pero la prueba es sobre la lista, no sobre la tabla).
        'CREATE POLICY platform_todo ON platform USING (id = current_user_id()::text)',
    );
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.excepcionesObsoletas, ['platform']);
      assert.match(String(explicarEsquema(estado)), /sobran excepciones/);
    } finally {
      await t.admin('DROP POLICY platform_todo ON platform; ALTER TABLE platform NO FORCE ROW LEVEL SECURITY; ALTER TABLE platform DISABLE ROW LEVEL SECURITY');
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
    'CREATE TABLE zz_nota (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id), deal_id uuid REFERENCES deal(id)); ' +
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
