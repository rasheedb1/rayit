/**
 * ACC-2 · audit(): misma transacción (rollback se la lleva), actor desde
 * la base (web con y sin identidad, job), redacción demostrada con el
 * volcado de columnas de texto, id que no sale, aislamiento por
 * workspace y bitácora que mc_app no corrige ni borra.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump } from '@mc/connectors';
import {
  audit, auditAsJob, assertAuditAction, AUDIT_ACTIONS, CORREO_OMITIDO, InvalidAuditActionError, isForbiddenAuditKey,
  sanitizeForAudit, type AuditAction,
} from '../src/audit.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** app_user del seed (0002/0003): Laura Méndez. */
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000ac02';
const INVOICE_ID = '00000003-0000-4000-8000-0000fac26001';

interface Fila {
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-bitacora', 'Workspace ajeno', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
  `);
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

/** Las filas de una acción vistas desde un workspace. Nunca pide el id. */
async function filas(workspaceId: string, action: string): Promise<Fila[]> {
  const { rows } = await t.db.withWorkspace(workspaceId, (tx) =>
    tx.query<Fila>(
      `SELECT actor_user_id, actor_kind, action, entity_type, entity_id, before, after
         FROM audit_log WHERE action = $1 ORDER BY created_at, entity_id`,
      [action],
    ),
  );
  return rows;
}

describe('la fila va en la misma transacción que la escritura', () => {
  test('si la transacción falla después de audit(), no queda bitácora', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        await audit(tx, { action: 'invoice.voided', entityType: 'invoice', entityId: INVOICE_ID, before: { status: 'sent' }, after: { status: 'void' } });
        throw new Error('la escritura de después falló');
      }),
      /la escritura de después falló/,
    );
    assert.deepEqual(await filas(WORKSPACE_LAURA, 'invoice.voided'), []);
  });

  test('audit() no devuelve nada: el id bigserial no sale de la base', async () => {
    const out = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      audit(tx, { action: 'invoice.sent', entityType: 'invoice', entityId: INVOICE_ID, before: { status: 'draft' }, after: { status: 'sent' } }),
    );
    assert.equal(out, undefined);
    const [fila] = await filas(WORKSPACE_LAURA, 'invoice.sent');
    assert.ok(fila);
    assert.equal('id' in fila, false);
  });
});

describe('el actor sale de la base, no de un parámetro', () => {
  test('con identidad en la transacción: actor_kind user y actor_user_id de la sesión', async () => {
    await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) => audit(tx, { action: 'invoice.paid', entityType: 'invoice', entityId: INVOICE_ID, before: { status: 'sent' }, after: { status: 'paid' } }),
      { userId: USER_LAURA },
    );
    const [fila] = await filas(WORKSPACE_LAURA, 'invoice.paid');
    assert.equal(fila?.actor_kind, 'user');
    assert.equal(fila?.actor_user_id, USER_LAURA);
    assert.equal(fila?.entity_type, 'invoice');
    assert.equal(fila?.entity_id, INVOICE_ID);
    assert.deepEqual(fila?.before, { status: 'sent' });
    assert.deepEqual(fila?.after, { status: 'paid' });
  });

  test('sin identidad (copia sin llaves, pruebas): actor_kind system y actor_user_id null, nunca "user" sin saber cuál', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      audit(tx, { action: 'invoice.reopened', entityType: 'invoice', entityId: INVOICE_ID, before: { status: 'void' } }),
    );
    const [fila] = await filas(WORKSPACE_LAURA, 'invoice.reopened');
    assert.equal(fila?.actor_kind, 'system');
    assert.equal(fila?.actor_user_id, null);
    assert.equal(fila?.after, null, 'un after omitido es NULL en la columna, no el JSON null');
  });

  test('desde el worker: actor_kind job, actor_user_id null, workspace explícito y el job en after._job', async () => {
    await t.db.asWorker((tx) =>
      auditAsJob(tx, {
        workspaceId: WORKSPACE_LAURA,
        job: { id: 'collect.account_metrics', runId: 42 },
        action: 'connection.disconnected',
        entityType: 'social_connection',
        entityId: '00000002-0000-4000-8000-000000000c01',
        before: { status: 'active' },
        after: { status: 'disabled' },
      }),
    );
    const [fila] = await filas(WORKSPACE_LAURA, 'connection.disconnected');
    assert.equal(fila?.actor_kind, 'job');
    assert.equal(fila?.actor_user_id, null);
    assert.deepEqual(fila?.after, { status: 'disabled', _job: { id: 'collect.account_metrics', runId: 42 } });
    assert.deepEqual(await filas(WORKSPACE_AJENO, 'connection.disconnected'), [], 'el otro workspace no la ve');
  });

  test('auditAsJob exige un workspace UUID y un job con id y runId', async () => {
    const base = { action: 'connection.disconnected' as const, entityType: 'social_connection', entityId: null };
    await assert.rejects(t.db.asWorker((tx) => auditAsJob(tx, { ...base, workspaceId: 'laura', job: { id: 'x', runId: 1 } })), /UUID/);
    await assert.rejects(t.db.asWorker((tx) => auditAsJob(tx, { ...base, workspaceId: WORKSPACE_LAURA, job: { id: '', runId: 1 } })), /job\.id/);
    await assert.rejects(t.db.asWorker((tx) => auditAsJob(tx, { ...base, workspaceId: WORKSPACE_LAURA, job: { id: 'x', runId: 1.5 } })), /runId/);
  });
});

describe('aislamiento', () => {
  test('lo escrito en un workspace no se ve desde otro (RLS de 0010)', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      audit(tx, { action: 'campaign.updated', entityType: 'campaign', entityId: null, before: { name: 'a' }, after: { name: 'b' } }),
    );
    assert.equal((await filas(WORKSPACE_LAURA, 'campaign.updated')).length, 1);
    assert.deepEqual(await filas(WORKSPACE_AJENO, 'campaign.updated'), []);
  });

  test('mc_app no corrige ni borra la bitácora (0025 §5)', async () => {
    const denied = (err: unknown) => err instanceof Error && /permission denied|permiso denegado/i.test(err.message);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE audit_log SET action = 'x.y'`)), denied);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query('DELETE FROM audit_log')), denied);
  });
});

describe('la forma de la acción', () => {
  test('acepta las de la lista y rechaza cualquier otra antes de tocar la base', () => {
    for (const a of AUDIT_ACTIONS) assert.doesNotThrow(() => assertAuditAction(a));
    for (const mala of ['factura creada', 'invoice', 'invoice.', 'Invoice.Created', 'invoice.created.now', 'deal.won']) {
      assert.throws(() => assertAuditAction(mala), InvalidAuditActionError, mala);
    }
  });

  test('un cast no cuela una acción inventada', async () => {
    // El cast simula a quien se salte el tipo: la base no llega a ver nada.
    const inventada = 'deal.won' as AuditAction;
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => audit(tx, { action: inventada, entityType: 'deal', entityId: null })),
      InvalidAuditActionError,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => audit(tx, { action: 'invoice.sent', entityType: 'Invoice', entityId: null })),
      /entity_type/,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => audit(tx, { action: 'invoice.sent', entityType: 'invoice', entityId: '12' })),
      /entity_id/,
    );
  });
});

describe('redacción', () => {
  const secretos = ['tok-ACCESO-1234567890', 'ref-REFRESCO-0987654321', 'conn:tiktok:abc123', 'ana@marca-tercera.com', '+57 300 000 0000', '203.0.113.7', 'Mozilla/5.0 (X11)'];

  test('las claves prohibidas se reconocen en cualquier forma', () => {
    for (const k of ['secretRef', 'secret_ref', 'email', 'contactEmail', 'correo_electronico', 'phone', 'telefono', 'ip', 'userAgent', 'user-agent', 'evidence', 'raw', 'cookie', 'sessionId', 'authUserId', 'password']) {
      assert.equal(isForbiddenAuditKey(k), true, k);
    }
    for (const k of ['clientIp', 'ipAddress', 'remote_addr', 'x-forwarded-for', 'X-Real-IP', 'userIp', 'direccion_ip']) {
      assert.equal(isForbiddenAuditKey(k), true, k);
    }
    for (const k of ['handle', 'status', 'zip', 'drawn', 'total', 'scopes', 'tokensCount', '_job', 'name', 'description', 'recipient', 'shipping']) {
      assert.equal(isForbiddenAuditKey(k), false, k);
    }
  });

  test('sanitizeForAudit: tokens tapados, claves prohibidas fuera, correos omitidos también dentro de una frase, bigint y fechas serializables', () => {
    const out = sanitizeForAudit({
      accessToken: secretos[0],
      secretRef: secretos[2],
      email: secretos[3],
      contact: { name: 'Ana', phone: secretos[4], correo: secretos[3] },
      evidence: { ip: secretos[5], userAgent: secretos[6] },
      raw: { anything: secretos[0] },
      tokens: { accessToken: secretos[0], refreshToken: secretos[1], accessExpiresAt: new Date(0) },
      notes: `escribir a ${secretos[3]}`,
      sender: secretos[3],
      totalCents: 123n,
      at: new Date('2026-09-23T10:00:00Z'),
      status: 'active',
      scopes: ['user.info.basic'],
    });
    assert.deepEqual(out, {
      accessToken: '[REDACTADO]',
      contact: { name: 'Ana' },
      tokens: '[OAuthTokens REDACTADO]',
      notes: `escribir a ${CORREO_OMITIDO}`,
      sender: CORREO_OMITIDO,
      totalCents: '123',
      at: '2026-09-23T10:00:00.000Z',
      status: 'active',
      scopes: ['user.info.basic'],
    });
    assert.deepEqual(
      sanitizeForAudit({
        trackingUrl: 'https://www.tiktok.com/@selva.thegolden/video/7312',
        brief: 'Mencionar (@cafe.alma) y a @nicolasduartea en el reel',
      }),
      {
        trackingUrl: 'https://www.tiktok.com/@selva.thegolden/video/7312',
        brief: 'Mencionar (@cafe.alma) y a @nicolasduartea en el reel',
      },
      'una URL con @ y una mención no son correos',
    );
    assert.equal(sanitizeForAudit(undefined), null);
    assert.equal(sanitizeForAudit(null), null);
  });

  test('en la base no aparece ningún secreto ni PII de terceros: volcado de todas las columnas de texto de audit_log', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      audit(tx, {
        action: 'connection.added',
        entityType: 'social_connection',
        entityId: '00000002-0000-4000-8000-000000000c02',
        before: { secret_ref: secretos[2], owner: { email: secretos[3] } },
        after: {
          handle: 'nicolasduartea',
          tokens: { accessToken: secretos[0], refreshToken: secretos[1], accessExpiresAt: new Date(0) },
          secretRef: secretos[2],
          evidence: { ip: secretos[5], userAgent: secretos[6], textShown: 'Autorizo' },
          contact: { phone: secretos[4] },
          replyTo: secretos[3],
        },
      }),
    );
    // Como mc_worker: todas las tablas y todos los workspaces. mc_app no
    // lee contact_suppression (0029) y el volcado recorre public entero.
    const dump = await t.db.asWorker((tx) => dumpTextColumns(tx));
    assert.ok(dump.some((d) => d.table === 'audit_log' && d.column === 'after' && d.text.includes('nicolasduartea')), 'el volcado sí ve lo permitido');
    assert.equal(findSecretInDump(dump, secretos), null);
    const [fila] = await filas(WORKSPACE_LAURA, 'connection.added');
    assert.deepEqual(fila?.before, { owner: {} });
    assert.deepEqual(fila?.after, { handle: 'nicolasduartea', tokens: '[OAuthTokens REDACTADO]', contact: {}, replyTo: CORREO_OMITIDO });
  });
});
