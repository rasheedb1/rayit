/**
 * ACC-3 · La migración 0034_access_control contra Postgres embebido.
 *
 * Lo que tiene que quedar en la base, y se comprueba aquí con SQL crudo
 * (sin depender del esquema Drizzle, que es de Rasheed):
 *
 *   - las seis tablas nuevas y las columnas que cambian (membership
 *     sin `role` y con `role_id`; audit_log con on_behalf_of_workspace_id
 *     y 'delegate');
 *   - los diez roles de sistema con EXACTAMENTE la matriz de @mc/core
 *     (ROLES_SISTEMA, ACC-1), y la semilla de 0034 §4 idéntica a la
 *     salida de `pnpm --filter @mc/core permisos:sql`;
 *   - la membresía del seed queda como Dueño de creador;
 *   - invitation: una pendiente por correo, token solo como SHA-256,
 *     y el token en claro no aparece en ninguna columna de texto;
 *   - RLS: otro workspace no ve invitaciones ni alcances; una concesión
 *     la ven sus dos extremos y nadie más;
 *   - privilegios: mc_app no escribe permission, role, role_permission
 *     ni workspace_grant, y no borra invitaciones;
 *   - el relleno de membership.role → role_id por tipo de workspace,
 *     sobre una base «como estaba» antes de 0034;
 *   - correr la migración dos veces no falla ni cambia nada, y correrla
 *     sobre una base sin 0025/0028 se para con un mensaje claro;
 *   - las políticas de membership (CIM-3) siguen funcionando:
 *     listMyWorkspaces devuelve el rol por su clave.
 *
 * Corre como mc_app sobre pglite con las migraciones y los seeds reales.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';
import type { BaseTx, WorkspaceTx } from '../src/client.ts';
import { createEmbeddedDb } from '../src/embedded.ts';
import { listMyWorkspaces } from '../src/queries/identidad.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import { PERMISOS, ROLES_SISTEMA } from '@mc/core';
import { generarSemillaSql } from '@mc/core/scripts/permisos-sql.ts';

const MIGRACION = '0034_access_control.sql';
/** Ids fijos del seed 0002. */
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
/** Escenario propio de esta prueba. */
const WS_B = '00000034-0000-4000-8000-00000000000b';
const WS_C = '00000034-0000-4000-8000-00000000000c';
const WS_AGENCIA = '00000034-0000-4000-8000-0000000000a9';
const USER_B = '00000034-0000-4000-8000-0000000000b1';
const USER_AGENCIA = '00000034-0000-4000-8000-0000000000a1';

/** Drizzle y pg envuelven el error; el motivo real va en `cause`. */
function mensajes(err: unknown): string {
  const partes: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return partes.join(' ← ');
}
const esPermisoDenegado = (err: unknown) => /permission denied/i.test(mensajes(err));
const esUnicoViolado = (err: unknown) => /duplicate key|unique/i.test(mensajes(err));
const esCheckViolado = (err: unknown) => /check constraint|check_violation|violates check|de otro workspace|de tipo/i.test(mensajes(err));
/** RLS, privilegio, referencia invisible (0025 §3) o el CHECK del disparador de 0034 §5: rechazada por la base. */
const esRechazada = (err: unknown) =>
  /row-level security|permission denied|no existe o que esta transacción no puede ver/i.test(mensajes(err)) || esCheckViolado(err);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface Fila extends Record<string, unknown> {
  n: number;
}
/** count(*) con lo que la transacción actual puede ver. */
const conteo = (tx: BaseTx, sql: string) => tx.query<Fila>(sql).then((r) => r.rows[0]?.n ?? -1);

/**
 * Cada bloque espera al `before` que abre la base embebida, y este es el
 * primer archivo del paquete en abrirla: paga el arranque en frío del
 * WASM de PGlite. Con la máquina cargada eso pasa de los 120 s de
 * --test-timeout y, con --test-isolation=none, la cancelación arrastra
 * la suite entera. Diez minutos por bloque, como el `before`.
 */
const TIEMPO_BLOQUE = 600_000;

let t: TestDb;
let sqlMigracion = '';
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

before(async () => {
  t = await openTestDb();
  sqlMigracion = await readFile(join(MIGRATIONS_DIR, MIGRACION), 'utf8');
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES
      ('${WS_B}', 'acc3-b', 'Workspace B'),
      ('${WS_C}', 'acc3-c', 'Workspace C');
    INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_AGENCIA}', 'acc3-agencia', 'Agencia', 'agency');
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_B}', 'b@acc3.test', 'Persona B'),
      ('${USER_AGENCIA}', 'agencia@acc3.test', 'Persona de agencia');
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_B}', '${USER_B}', system_role_id('creator', 'owner'));
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_AGENCIA}', '${USER_AGENCIA}', system_role_id('agency', 'owner'));
  `);
}, { timeout: TIEMPO_BLOQUE });

after(async () => {
  await t?.close();
});

describe('0034: tablas, columnas y semilla', { timeout: TIEMPO_BLOQUE }, () => {
  test('las seis tablas nuevas existen, membership cambió de columna y audit_log admite delegados', async () => {
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('permission', 'role', 'role_permission', 'membership_scope', 'invitation', 'workspace_grant', 'membership', 'audit_log')
          ORDER BY 1, 2`,
      ),
    );
    const columnas = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const esperada of [
      'permission.key', 'permission.module', 'permission.label_es', 'permission.sensitivity',
      'role.id', 'role.workspace_id', 'role.key', 'role.workspace_kind', 'role.label_es', 'role.is_system',
      'role_permission.role_id', 'role_permission.permission_key',
      'membership_scope.workspace_id', 'membership_scope.user_id', 'membership_scope.scope_type', 'membership_scope.scope_id',
      'invitation.workspace_id', 'invitation.email', 'invitation.role_id', 'invitation.scope', 'invitation.token_hash',
      'invitation.invited_by', 'invitation.expires_at', 'invitation.accepted_at', 'invitation.revoked_at',
      'workspace_grant.grantor_workspace_id', 'workspace_grant.grantee_workspace_id', 'workspace_grant.role_id',
      'workspace_grant.status', 'workspace_grant.requested_by', 'workspace_grant.approved_by',
      'membership.role_id', 'audit_log.on_behalf_of_workspace_id',
    ]) {
      assert.ok(columnas.has(esperada), `falta ${esperada}`);
    }
    assert.equal(columnas.has('membership.role'), false, 'membership.role tenía que desaparecer');

    const check = await t.db.withCatalogs((tx) =>
      tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_log_actor_kind_check'`,
      ),
    );
    assert.match(check.rows[0]?.def ?? '', /delegate/);
  });

  test('los diez roles de sistema con exactamente la matriz del catálogo', async () => {
    const permisos = await t.db.withCatalogs((tx) => tx.query<{ key: string }>('SELECT key FROM permission ORDER BY key'));
    assert.deepEqual(
      permisos.rows.map((r) => r.key).sort(),
      PERMISOS.map((p) => p.key).sort(),
      'el catálogo sembrado no es el de permisos.ts',
    );

    const roles = await t.db.withCatalogs((tx) =>
      tx.query<{ workspace_kind: string; key: string; label_es: string; is_system: boolean; permisos: string[] }>(
        `SELECT r.workspace_kind, r.key, r.label_es, r.is_system,
                coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permisos
           FROM role r
           LEFT JOIN role_permission rp ON rp.role_id = r.id
          WHERE r.workspace_id IS NULL
          GROUP BY r.id
          ORDER BY r.workspace_kind, r.key`,
      ),
    );
    assert.equal(roles.rows.length, ROLES_SISTEMA.length, 'no hay diez roles de sistema');
    for (const esperado of ROLES_SISTEMA) {
      const fila = roles.rows.find((r) => r.workspace_kind === esperado.workspaceKind && r.key === esperado.key);
      assert.ok(fila, `falta el rol ${esperado.workspaceKind}/${esperado.key}`);
      assert.equal(fila.label_es, esperado.labelEs);
      assert.equal(fila.is_system, true);
      assert.deepEqual(
        fila.permisos,
        [...esperado.permisos].sort(),
        `la matriz de ${esperado.workspaceKind}/${esperado.key} no coincide con permisos.ts`,
      );
    }
    const total = await t.db.withCatalogs((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM role_permission'));
    assert.equal(total, ROLES_SISTEMA.reduce((n, r) => n + r.permisos.length, 0));
  });

  test('la semilla de 0034 §4 es, línea por línea, la salida del script de ACC-1', () => {
    // Si alguien cambia el catálogo de core sin traer una migración nueva,
    // o edita la semilla a mano, esto falla. La cabecera del script (sus
    // comentarios iniciales) no viaja a la migración.
    const delScript = generarSemillaSql().slice(generarSemillaSql().indexOf('INSERT INTO permission')).trim();
    const desde = sqlMigracion.indexOf('INSERT INTO permission');
    const hasta = sqlMigracion.indexOf('ON CONFLICT DO NOTHING;', sqlMigracion.indexOf('INSERT INTO role_permission')) + 'ON CONFLICT DO NOTHING;'.length;
    assert.equal(sqlMigracion.slice(desde, hasta).trim(), delScript);
  });

  test('decisión E: el Mánager de creador no ve el flujo de caja ni conecta cuentas; el Contador no edita campañas', async () => {
    const tiene = async (kind: string, key: string, permiso: string) =>
      (await t.db.withCatalogs((tx) =>
        conteo(
          tx,
          `SELECT count(*)::int AS n FROM role_permission rp WHERE rp.role_id = system_role_id('${kind}', '${key}') AND rp.permission_key = '${permiso}'`,
        ),
      )) === 1;
    assert.equal(await tiene('creator', 'manager', 'finanzas.flujo.ver'), false);
    assert.equal(await tiene('creator', 'manager', 'conexiones.cuenta.conectar'), false);
    assert.equal(await tiene('creator', 'manager', 'campanas.reporte.enviar'), true);
    assert.equal(await tiene('creator', 'finance', 'campanas.campana.editar'), false);
    assert.equal(await tiene('creator', 'owner', 'equipo.workspace.configurar'), true);
    assert.equal(await tiene('agency', 'admin', 'equipo.workspace.configurar'), false);
  });

  test('system_role_id: el id de un rol de sistema, o NULL si no existe para ese tipo', async () => {
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ owner: string | null; admin_creador: string | null }>(
        `SELECT system_role_id('creator', 'owner')::text AS owner, system_role_id('creator', 'admin')::text AS admin_creador`,
      ),
    );
    assert.match(rows[0]?.owner ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(rows[0]?.admin_creador, null, 'no existe «admin» de creador');
  });

  test('la membresía del seed queda como Dueño de creador y listMyWorkspaces la devuelve por su clave', async () => {
    const { rows } = await laura((tx) =>
      tx.query<{ key: string; workspace_kind: string }>(
        `SELECT r.key, r.workspace_kind FROM membership m JOIN role r ON r.id = m.role_id WHERE m.user_id = '${USER_LAURA}'`,
      ),
    );
    assert.deepEqual(rows, [{ key: 'owner', workspace_kind: 'creator' }]);
    // CIM-3: la política membership_read («las mías») y el JOIN con role.
    const mios = await t.db.withIdentity({ userId: USER_LAURA }, (tx) => listMyWorkspaces(tx));
    assert.deepEqual(mios.map((w) => [w.id, w.role]), [[WORKSPACE_LAURA, 'owner']]);
  });
});

describe('0034: invitation', { timeout: TIEMPO_BLOQUE }, () => {
  const token = randomBytes(32).toString('base64url');
  const invitar = (correo: string, hash = sha256(randomBytes(32).toString('base64url'))) => (tx: WorkspaceTx) =>
    tx.query(
      `INSERT INTO invitation (workspace_id, email, role_id, token_hash, invited_by, expires_at)
       VALUES (current_workspace_id(), $1, system_role_id('creator', 'manager'), $2, $3, now() + interval '7 days')
       RETURNING id`,
      [correo, hash, USER_LAURA],
    );

  test('una sola pendiente por correo y workspace; revocada, se puede volver a invitar', async () => {
    await laura(invitar('manager@acc3.test', sha256(token)));
    await assert.rejects(laura(invitar('Manager@ACC3.test')), esUnicoViolado, 'citext: el mismo correo con otras mayúsculas');
    await laura((tx) => tx.query(`UPDATE invitation SET revoked_at = now() WHERE email = 'manager@acc3.test' AND revoked_at IS NULL`));
    await laura(invitar('manager@acc3.test'));
    const pendientes = await laura((tx) =>
      conteo(tx, `SELECT count(*)::int AS n FROM invitation WHERE email = 'manager@acc3.test' AND revoked_at IS NULL AND accepted_at IS NULL`),
    );
    assert.equal(pendientes, 1);
  });

  test('el token solo cabe como SHA-256: el CHECK rechaza el token en claro y cualquier otra cosa', async () => {
    await assert.rejects(laura(invitar('otro@acc3.test', token)), esCheckViolado);
    await assert.rejects(laura(invitar('otro@acc3.test', 'abc')), esCheckViolado);
    await assert.rejects(
      laura((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, expires_at, accepted_at, revoked_at)
           VALUES (current_workspace_id(), 'ambas@acc3.test', system_role_id('creator', 'viewer'), $1, now(), now(), now())`,
          [sha256('ambas')],
        ),
      ),
      esCheckViolado,
      'aceptada y revocada a la vez',
    );
  });

  test('R4: el token en claro no aparece en ninguna columna de texto de la base', async () => {
    const dump = await t.db.asWorker(async (tx) => {
      const cols = await tx.query<{ tabla: string; columna: string }>(
        `SELECT c.relname AS tabla, a.attname AS columna
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type t ON t.oid = a.atttypid
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND (t.typname IN ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', 'bytea') OR t.typname LIKE '\\_%')`,
      );
      const textos: string[] = [];
      for (const { tabla, columna } of cols.rows) {
        const r = await tx.query<{ texto: string }>(
          `SELECT coalesce(string_agg("${columna}"::text, E'\\n'), '') AS texto FROM "${tabla}"`,
        );
        textos.push(`${tabla}.${columna}: ${r.rows[0]?.texto ?? ''}`);
      }
      return textos;
    });
    assert.equal(dump.some((s) => s.includes(token)), false, 'el token de la invitación quedó en claro');
    assert.equal(dump.some((s) => s.startsWith('invitation.token_hash') && s.includes(sha256(token))), true, 'la sonda no vio el hash: no está mirando');
  });

  test('otro workspace no ve las invitaciones ni puede escribirlas; la web no las borra', async () => {
    const deB = await t.db.withWorkspace(WS_B, (tx) => conteo(tx, 'SELECT count(*)::int AS n FROM invitation'), { userId: USER_B });
    assert.equal(deB, 0);
    await assert.rejects(
      t.db.withWorkspace(
        WS_B,
        (tx) =>
          tx.query(
            `INSERT INTO invitation (workspace_id, email, role_id, token_hash, expires_at)
             VALUES ('${WORKSPACE_LAURA}', 'intrusa@acc3.test', system_role_id('creator', 'owner'), $1, now() + interval '1 day')`,
            [sha256('intrusa')],
          ),
        { userId: USER_B },
      ),
      esRechazada,
    );
    const sinWorkspace = await t.db.withCatalogs((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM invitation'));
    assert.equal(sinWorkspace, 0, 'sin workspace fijado se enumeraban las invitaciones');
    await assert.rejects(laura((tx) => tx.query('DELETE FROM invitation')), esPermisoDenegado);
  });
});

describe('0034: membership_scope, workspace_grant, roles y privilegios', { timeout: TIEMPO_BLOQUE }, () => {
  test('membership_scope: se lee solo en el workspace fijado, y la web no lo escribe ni lo borra', async () => {
    await t.admin(`
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
      VALUES ('${WORKSPACE_LAURA}', '${USER_LAURA}', 'creator', '${CREATOR_LAURA}');
    `);
    assert.equal(await laura((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM membership_scope')), 1);
    assert.equal(await t.db.withWorkspace(WS_B, (tx) => conteo(tx, 'SELECT count(*)::int AS n FROM membership_scope')), 0);
    assert.equal(await t.db.withCatalogs((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM membership_scope')), 0);
    for (const sentencia of [
      `INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
       VALUES (current_workspace_id(), '${USER_LAURA}', 'company', '${CREATOR_LAURA}')`,
      // Borrar el propio alcance sería ver todo el workspace.
      'DELETE FROM membership_scope',
      `UPDATE membership_scope SET scope_id = '${CREATOR_LAURA}'`,
    ]) {
      await assert.rejects(laura((tx) => tx.query(sentencia)), esPermisoDenegado, sentencia);
    }
    await t.admin('DELETE FROM membership_scope');
  });

  test('workspace_grant: mc_app no la escribe; la ven quien concede y quien recibe, y nadie más', async () => {
    await assert.rejects(
      laura((tx) =>
        tx.query(
          `INSERT INTO workspace_grant (grantor_workspace_id, grantee_workspace_id, role_id)
           VALUES (current_workspace_id(), '${WS_AGENCIA}', system_role_id('creator', 'manager'))`,
        ),
      ),
      esPermisoDenegado,
    );
    await t.admin(`
      INSERT INTO workspace_grant (grantor_workspace_id, grantee_workspace_id, role_id, status)
      VALUES ('${WORKSPACE_LAURA}', '${WS_AGENCIA}', system_role_id('creator', 'manager'), 'active');
    `);
    const n = (ws: string) => t.db.withWorkspace(ws, (tx) => conteo(tx, 'SELECT count(*)::int AS n FROM workspace_grant'));
    assert.equal(await n(WORKSPACE_LAURA), 1, 'quien concede');
    assert.equal(await n(WS_AGENCIA), 1, 'quien recibe');
    assert.equal(await n(WS_C), 0, 'un tercero');
    assert.equal(await t.db.withCatalogs((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM workspace_grant')), 0, 'sin workspace');
  });

  test('role: los de sistema se ven desde todos; uno a medida solo desde su workspace; mc_app no los crea', async () => {
    await assert.rejects(
      t.db.withWorkspace(
        WS_B,
        (tx) => tx.query(`INSERT INTO role (workspace_id, key, workspace_kind, label_es) VALUES (current_workspace_id(), 'becario', 'creator', 'Becario')`),
        { userId: USER_B },
      ),
      esPermisoDenegado,
    );
    await t.admin(`INSERT INTO role (workspace_id, key, workspace_kind, label_es) VALUES ('${WS_B}', 'becario', 'creator', 'Becario')`);
    const claves = (ws: string) =>
      t.db.withWorkspace(ws, (tx) => tx.query<{ key: string }>(`SELECT key FROM role WHERE key = 'becario'`)).then((r) => r.rows.length);
    assert.equal(await claves(WS_B), 1);
    assert.equal(await claves(WORKSPACE_LAURA), 0);
    assert.equal(await t.db.withCatalogs((tx) => conteo(tx, 'SELECT count(*)::int AS n FROM role WHERE workspace_id IS NULL')), 10);
    for (const sentencia of [
      `INSERT INTO permission (key, module, label_es) VALUES ('x.y.ver', 'x', 'X')`,
      `INSERT INTO role_permission (role_id, permission_key) VALUES (system_role_id('creator', 'viewer'), 'finanzas.flujo.ver')`,
      `UPDATE permission SET label_es = 'pisado'`,
      `DELETE FROM role_permission`,
    ]) {
      await assert.rejects(laura((tx) => tx.query(sentencia)), esPermisoDenegado, sentencia);
    }
  });

  test('el rol tiene que ser del tipo del workspace, y un rol a medida solo vale en el suyo', async () => {
    // Como superusuario (sin RLS de por medio): lo que rechaza es el
    // disparador role_fits_workspace, no una política.
    await assert.rejects(
      t.admin(`INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_AGENCIA}', '${USER_B}', system_role_id('creator', 'manager'))`),
      esCheckViolado,
      'un rol de creador en un workspace de agencia',
    );
    await assert.rejects(
      t.admin(`INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_C}', '${USER_B}', (SELECT id FROM role WHERE key = 'becario'))`),
      esCheckViolado,
      'el rol a medida de B en el workspace C',
    );
    // Un rol a medida sí vale en su propio workspace, y la pantalla de
    // cuenta lo muestra como «Solo lectura» (nunca como más).
    const USER_BECARIO = '00000034-0000-4000-8000-0000000000b2';
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${USER_BECARIO}', 'becario@acc3.test', 'Becario');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_B}', '${USER_BECARIO}', (SELECT id FROM role WHERE key = 'becario'));
    `);
    // Con withIdentity, como lo pide la web: sin workspace fijado el rol
    // a medida no se ve (role_read), y el espacio no puede desaparecer.
    const suyos = await t.db.withIdentity({ userId: USER_BECARIO }, (tx) => listMyWorkspaces(tx));
    assert.deepEqual(suyos.map((w) => [w.id, w.role]), [[WS_B, 'viewer']]);
    // La misma regla en la invitación y en la concesión: se rechazan al
    // escribirlas, no al aceptarlas.
    await assert.rejects(
      laura((tx) =>
        tx.query(
          `INSERT INTO invitation (workspace_id, email, role_id, token_hash, expires_at)
           VALUES (current_workspace_id(), 'agencia@acc3.test', system_role_id('agency', 'admin'), $1, now() + interval '1 day')`,
          [sha256('rol-de-agencia')],
        ),
      ),
      esCheckViolado,
      'una invitación con un rol de agencia a un workspace de creador',
    );
    await assert.rejects(
      t.admin(`INSERT INTO workspace_grant (grantor_workspace_id, grantee_workspace_id, role_id)
               VALUES ('${WS_C}', '${WS_AGENCIA}', system_role_id('agency', 'manager'))`),
      esCheckViolado,
      'una concesión cuyo rol no es del tipo de quien concede',
    );
    // Un rol a medida no puede llamarse como uno de fábrica.
    await assert.rejects(
      t.admin(`INSERT INTO role (workspace_id, key, workspace_kind, label_es) VALUES ('${WS_B}', 'owner', 'creator', 'Falso dueño')`),
      esCheckViolado,
      'un rol a medida con la clave owner',
    );
    // Y sin DEFAULT: una membresía sin rol no entra.
    await assert.rejects(
      t.admin(`INSERT INTO membership (workspace_id, user_id) VALUES ('${WS_C}', '${USER_B}')`),
      (err: unknown) => /not-null|null value/i.test(mensajes(err)),
    );
  });
});

describe('0034: el archivo, dos veces y al revés', { timeout: TIEMPO_BLOQUE }, () => {
  test('aplicarla otra vez como el rol que migra no falla ni cambia nada', async () => {
    const foto = () =>
      t.db.withCatalogs((tx) =>
        tx.query<{ permisos: number; roles: number; matriz: number; politicas: number; disparadores: number }>(
          `SELECT (SELECT count(*)::int FROM permission) AS permisos,
                  (SELECT count(*)::int FROM role WHERE workspace_id IS NULL) AS roles,
                  (SELECT count(*)::int FROM role_permission) AS matriz,
                  (SELECT count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                    WHERE c.relname IN ('role', 'role_permission', 'membership_scope', 'invitation', 'workspace_grant')) AS politicas,
                  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
                    ('ref_visible_role_id', 'role_fits_workspace', 'ref_visible_invited_by', 'ref_visible_on_behalf_of_workspace_id')) AS disparadores`,
        ),
      );
    const antes = await foto();
    assert.equal(antes.rows[0]?.roles, 10);
    await t.admin(`SET ROLE mc_migrator_embedded;\n${sqlMigracion}\nRESET ROLE;`);
    const despues = await foto();
    assert.deepEqual(despues.rows, antes.rows);
    // La membresía del seed sigue con su rol: el relleno no volvió a correr.
    const filas = await laura((tx) =>
      tx.query<{ key: string }>(`SELECT r.key FROM membership m JOIN role r ON r.id = m.role_id WHERE m.user_id = '${USER_LAURA}'`),
    );
    assert.deepEqual(filas.rows, [{ key: 'owner' }]);
  });

  test('sobre una base sin 0025 se para con un mensaje claro', async () => {
    const vieja = await createEmbeddedDb({ hasta: '0022_public_profile_access.sql' });
    try {
      await assert.rejects(vieja.execAsSuperuser(sqlMigracion), /0025_referencias_visibles/);
    } finally {
      await vieja.close();
    }
  });

  test('el relleno: cada rol viejo va a su rol de fábrica según el tipo de workspace, sin subir a nadie', async () => {
    const db = await createEmbeddedDb({ hasta: '0033_una_aceptada_por_negocio.sql' });
    try {
      const CREADOR = '00000034-0000-4000-8000-0000000000c1';
      const AGENCIA = '00000034-0000-4000-8000-0000000000a2';
      const viejos = ['owner', 'admin', 'member', 'viewer', 'client'] as const;
      const usuario = (kind: string, rol: (typeof viejos)[number]) =>
        `00000034-0000-4000-8000-${kind === 'creator' ? '0c' : '0a'}${viejos.indexOf(rol)}000000001`;
      const sql: string[] = [
        `INSERT INTO workspace (id, slug, name, kind) VALUES ('${CREADOR}', 'relleno-creador', 'Creador', 'creator'), ('${AGENCIA}', 'relleno-agencia', 'Agencia', 'agency');`,
      ];
      for (const kind of ['creator', 'agency']) {
        for (const rol of viejos) {
          const ws = kind === 'creator' ? CREADOR : AGENCIA;
          sql.push(`INSERT INTO app_user (id, email, name) VALUES ('${usuario(kind, rol)}', '${kind}-${rol}@relleno.test', '${kind} ${rol}');`);
          sql.push(`INSERT INTO membership (workspace_id, user_id, role) VALUES ('${ws}', '${usuario(kind, rol)}', '${rol}');`);
        }
      }
      await db.execAsSuperuser(sql.join('\n'));
      const aplicadas = await db.migrar();
      // La primera que corre desde 0033 es la de accesos, que es la que
      // hace el relleno. No se exige que sea la ÚNICA: detrás vienen las
      // migraciones de otras historias (FIN-7 trajo 0036), y afirmar
      // aquí cuál es la última hacía fallar esta prueba a cualquiera que
      // agregara una.
      assert.equal(aplicadas[0], MIGRACION);
      assert.ok(aplicadas.includes(MIGRACION));

      const { rows } = await db.queryAsSuperuser<{ kind: string; user_id: string; key: string }>(
        `SELECT w.kind, m.user_id, r.key FROM membership m JOIN workspace w ON w.id = m.workspace_id JOIN role r ON r.id = m.role_id
          WHERE w.id IN ('${CREADOR}', '${AGENCIA}')`,
      );
      const esperado: Record<string, Record<string, string>> = {
        creator: { owner: 'owner', admin: 'manager', member: 'editor', viewer: 'viewer', client: 'viewer' },
        agency: { owner: 'owner', admin: 'admin', member: 'manager', viewer: 'viewer', client: 'viewer' },
      };
      assert.equal(rows.length, 10);
      for (const kind of ['creator', 'agency']) {
        for (const rol of viejos) {
          const fila = rows.find((r) => r.kind === kind && r.user_id === usuario(kind, rol));
          assert.equal(fila?.key, esperado[kind]![rol], `${kind}: ${rol} → ${esperado[kind]![rol]}`);
        }
      }
      const columnas = await db.queryAsSuperuser<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'membership' AND column_name = 'role'`,
      );
      assert.equal(columnas.rows[0]?.n, 0, 'la columna role tenía que desaparecer tras el relleno');
    } finally {
      await db.close();
    }
  });
});
