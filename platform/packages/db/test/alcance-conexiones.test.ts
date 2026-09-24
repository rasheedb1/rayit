/**
 * ACC-6 · Alcance en queries/conexiones.ts: un miembro con alcance a
 * Laura no ve las cuentas, consentimientos, snapshots ni la audiencia de
 * Sofía en NINGUNA función exportada, y no puede conectar, desconectar,
 * anotar ni avisar nada de Sofía. Ver test/alcance.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as conexiones from '../src/queries/conexiones.ts';
import { ScopeError } from '../src/scope.ts';
import { WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import {
  CONEXION_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, definirPruebasDeAlcance, EXTERNAL_ACCOUNT_SOFIA, HANDLE_SOFIA, USER_LAURA,
  USER_MIEMBRO, USER_MIEMBRO_CAMPANA, USER_MIEMBRO_MARCA, type ArnesDeAlcance, type CasoDeAlcance,
} from './alcance.ts';

const {
  listConnections, findConnectionByAccount, getConsentCreator, getConnectionCreator, getDefaultCreatorId, getSessionMember,
  sessionHasPermission, listConsents, upsertConnection, recordConsent, disconnectConnection, notifyConnectionAdded, addPublicAccount,
  recordAccountSnapshot, listAccounts, markAccountLookupFailure, findPublicAccountByHandle, upgradePublicAccountToOAuth,
  getAccountAudience, listAccountAudience, ConnectionNotFound, CreatorNotInWorkspace,
} = conexiones;

/** Un cuarto miembro, solo de este módulo: alcance creator = Sofía. Prueba que «el primero» es el primero DEL ALCANCE. */
const USER_MIEMBRO_SOFIA = '0000000a-0000-4000-8000-000000000032';

/** La demografía y un hueco de la cuenta de Sofía (CON-7), y el miembro con alcance a Sofía. */
async function sembrarConexiones(t: TestDb): Promise<void> {
  await t.admin(`
    INSERT INTO app_user (id, email, name, locale) VALUES ('${USER_MIEMBRO_SOFIA}', 'miembro.sofia@ejemplo.com', 'Miembro de Sofía', 'es-CO') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WORKSPACE_LAURA}', '${USER_MIEMBRO_SOFIA}', system_role_id('creator', 'manager')) ON CONFLICT DO NOTHING;
    INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
    VALUES ('${WORKSPACE_LAURA}', '${USER_MIEMBRO_SOFIA}', 'creator', '${CREATOR_SOFIA}') ON CONFLICT DO NOTHING;

    INSERT INTO audience_breakdown (workspace_id, scope, connection_id, day, population, dimension, bucket, share, absolute)
    VALUES ('${WORKSPACE_LAURA}', 'account', '${CONEXION_SOFIA}', CURRENT_DATE - 1, 'followers', 'country', 'CO', NULL, 6100)
    ON CONFLICT DO NOTHING;
    INSERT INTO metric_gap (workspace_id, connection_id, metric_group, requirement_id, day)
    VALUES ('${WORKSPACE_LAURA}', '${CONEXION_SOFIA}', 'demografia_de_cuenta', 'tt.audience.auth', CURRENT_DATE - 1)
    ON CONFLICT DO NOTHING;
  `);
  huellaAntes = await huellaComoDuena(t);
}

/**
 * Cuántos avisos 'connection_added' hay de la cuenta de Sofía, leídos como la dueña (el aviso es para ella).
 * No con t.raw(): corre sin workspace fijado y RLS le esconde notification, así que contaría siempre cero.
 */
async function avisosDeSofia(duena: ArnesDeAlcance['duena']): Promise<number> {
  const { rows } = await duena((tx) => tx.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM notification WHERE kind = 'connection_added' AND entity_id = $1`,
    [CONEXION_SOFIA],
  ));
  return Number(rows[0]?.n ?? 0);
}

/** Las tablas que escribe queries/conexiones.ts, notification y audit_log incluidas (la huella de alcance.ts no las mira). */
const TABLAS_DE_CONEXIONES = ['social_connection', 'data_consent', 'account_metric_snapshot', 'connection_secret', 'notification', 'audit_log'] as const;

/**
 * Huella de esas tablas LEÍDA COMO LA DUEÑA (workspace fijado, sin alcance). La de alcance.ts usa t.raw(), que
 * corre como mc_app sin workspace: RLS le esconde todas las filas y compara md5('') con md5('').
 */
async function huellaComoDuena(t: TestDb): Promise<Record<string, string>> {
  return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
    const out: Record<string, string> = {};
    for (const tabla of TABLAS_DE_CONEXIONES) {
      const { rows } = await tx.query<{ n: number | string; h: string }>(
        `SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${tabla} x`,
      );
      out[tabla] = `${rows[0]?.n}:${rows[0]?.h}`;
    }
    return out;
  }, { userId: USER_LAURA });
}

/** La huella tomada al sembrar, antes de la pasada del miembro. */
let huellaAntes: Record<string, string> | undefined;

const AVISO = { titleEs: 'Una cuenta se conectó en tu nombre', bodyEs: 'Alguien conectó @sofia.viaja.' } as const;

const FIRMA_TOKEN = { displayName: null, avatarUrl: null, profileUrl: null, scopes: ['user.info.basic'], accessExpiresAt: new Date('2026-10-01T00:00:00Z'), refreshExpiresAt: null } as const;

const HOY = new Date().toISOString().slice(0, 10);

const CASOS: Record<string, CasoDeAlcance> = {
  listConnections: { run: (tx) => listConnections(tx), duena: 'nombra', miembro: 'nada' },
  listAccounts: { run: (tx) => listAccounts(tx), duena: 'nombra', miembro: 'nada' },
  findConnectionByAccount: { run: (tx) => findConnectionByAccount(tx, 'tiktok', EXTERNAL_ACCOUNT_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Solo la usa el callback de OAuth, que va a escribir: una fila de otra creadora fuera del alcance no es «no
  // existe» sino ScopeError; si no, el callback crearía una segunda fila para la misma cuenta real.
  // Catálogo global de prerrequisitos (CON-B): no es de nadie, no lleva alcance (alcance-convencion.test.ts lo declara).
  getMetricRequirement: { run: (tx) => conexiones.getMetricRequirement(tx, 'tt.insights.optin'), duena: 'pasa', miembro: 'nada' },
  // CON-12: mover la cuenta de Sofía al proveedor de pago. El miembro no la ve: false y sin escribir (la huella).
  setAccountAccessMode: { run: (tx) => conexiones.setAccountAccessMode(tx, CONEXION_SOFIA, 'aggregator'), duena: (r) => r === true, miembro: 'nada' },
  findPublicAccountByHandle: { run: (tx) => findPublicAccountByHandle(tx, 'tiktok', HANDLE_SOFIA), duena: 'nombra', miembro: { rechaza: ScopeError } },
  // Para las dos es Laura (la más antigua; para el miembro, la única de su alcance). Que sea «el primero DEL
  // alcance» lo muerden las pruebas propias con el miembro de Sofía y los de marca y campaña.
  getDefaultCreatorId: { run: (tx) => getDefaultCreatorId(tx), duena: (r) => r === CREATOR_LAURA, miembro: 'nada' },
  getConsentCreator: { run: (tx) => getConsentCreator(tx), duena: (r) => (r as { id?: string }).id === CREATOR_LAURA, miembro: 'nada' },
  getConnectionCreator: { run: (tx) => getConnectionCreator(tx, CONEXION_SOFIA), duena: 'nombra', miembro: { rechaza: ConnectionNotFound } },
  // Identidad y permisos de la propia persona: sin alcance a propósito (no son datos de una creadora).
  getSessionMember: { run: (tx) => getSessionMember(tx), duena: (r) => (r as { userId?: string } | null)?.userId === USER_LAURA, miembro: 'nada' },
  sessionHasPermission: { run: (tx) => sessionHasPermission(tx, 'conexiones.cuenta.ver'), duena: (r) => r === true, miembro: 'nada' },
  getAccountAudience: { run: (tx) => getAccountAudience(tx, CONEXION_SOFIA), duena: 'nombra', miembro: 'nada' },
  listAccountAudience: { run: (tx) => listAccountAudience(tx), duena: 'nombra', miembro: 'nada' },
  // Para el miembro, false y ningún aviso: la huella no mira notification, lo comprueba una prueba propia.
  notifyConnectionAdded: {
    run: (tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: CONEXION_SOFIA, ...AVISO }),
    duena: (r) => r === true,
    miembro: 'nada',
  },
  listConsents: { run: (tx) => listConsents(tx, CONEXION_SOFIA), duena: 'nombra', miembro: 'nada' },
  recordAccountSnapshot: {
    run: (tx) => recordAccountSnapshot(tx, { connectionId: CONEXION_SOFIA, day: HOY, followers: 9600, following: 100, mediaCount: 43, views: 530000, raw: {} }),
    duena: (r) => r === 'guardada',
    miembro: { rechaza: ConnectionNotFound },
  },
  // No lanza: dice si anotó. Para el miembro, false y ninguna fila tocada (lo comprueba la huella).
  markAccountLookupFailure: {
    run: (tx) => markAccountLookupFailure(tx, CONEXION_SOFIA, 'Sin métricas públicas.', false),
    duena: (r) => r === true,
    miembro: 'nada',
  },
  recordConsent: {
    run: (tx) => recordConsent(tx, { connectionId: CONEXION_SOFIA, creatorId: CREATOR_SOFIA, purpose: 'analytics', policyVersion: 'v2', evidence: {} }),
    duena: 'pasa',
    miembro: { rechaza: ConnectionNotFound },
  },
  addPublicAccount: {
    run: (tx) => addPublicAccount(tx, { creatorId: CREATOR_SOFIA, platformId: 'instagram', handle: 'sofia.ig', externalAccountId: 'sofia.ig', displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator' }),
    duena: 'pasa',
    miembro: { rechaza: CreatorNotInWorkspace },
  },
  upsertConnection: {
    run: (tx) => upsertConnection(tx, {
      creatorId: CREATOR_SOFIA, platformId: 'youtube', externalAccountId: 'UC-sofia', handle: 'sofiaviaja', displayName: null, avatarUrl: null, profileUrl: null,
      accountType: 'channel', secretRef: 'enc:youtube:0000000a-0000-4000-8000-0000000000aa', scopes: ['youtube.readonly'],
      accessExpiresAt: new Date('2026-10-01T00:00:00Z'), refreshExpiresAt: null,
    }),
    duena: 'pasa',
    miembro: { rechaza: CreatorNotInWorkspace },
  },
  upgradePublicAccountToOAuth: {
    run: (tx) => upgradePublicAccountToOAuth(tx, CONEXION_SOFIA, {
      externalAccountId: 'open_id_sofia', handle: HANDLE_SOFIA, displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator',
      secretRef: 'enc:tiktok:0000000a-0000-4000-8000-0000000000ab', scopes: ['user.info.basic'], accessExpiresAt: new Date('2026-10-01T00:00:00Z'), refreshExpiresAt: null,
    }),
    duena: 'pasa',
    miembro: { rechaza: ConnectionNotFound },
  },
  disconnectConnection: { run: (tx) => disconnectConnection(tx, CONEXION_SOFIA), duena: 'nombra', miembro: { rechaza: ConnectionNotFound } },
  publicSecretRef: 'pura',
};

definirPruebasDeAlcance('conexiones', conexiones, CASOS, ({ t, duena, miembro, como }) => {
  // Va primera entre las propias: después, las pruebas de abajo sí escriben (como la dueña o sobre lo de Laura).
  test('la pasada del miembro no escribió ni una fila, vista como la dueña (con notification y audit_log)', async () => {
    const despues = await huellaComoDuena(t());
    assert.ok(huellaAntes, 'la huella se tomó al sembrar');
    assert.ok(!despues.social_connection?.startsWith('0:'), 'la huella ve filas: si no, no probaría nada');
    assert.deepEqual(despues, huellaAntes);
  });

  test('notifyConnectionAdded: el miembro no avisa de la cuenta de Sofía (false, sin fila); de una de Laura, sí', async () => {
    assert.equal(await miembro((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: CONEXION_SOFIA, ...AVISO })), false);
    assert.equal(await avisosDeSofia(duena), 0, 'el miembro no dejó aviso de la cuenta de Sofía');
    const deLaura = (await miembro((tx) => listConnections(tx)))[0];
    assert.ok(deLaura, 'Laura tiene cuentas');
    assert.equal(await miembro((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: deLaura.id, ...AVISO })), true);
  });

  test('getConsentCreator y getDefaultCreatorId dan el primero DEL ALCANCE: al miembro de Sofía, Sofía (aunque Laura sea más antigua)', async () => {
    assert.equal((await como(USER_MIEMBRO_SOFIA, (tx) => getConsentCreator(tx))).id, CREATOR_SOFIA);
    assert.equal(await como(USER_MIEMBRO_SOFIA, (tx) => getDefaultCreatorId(tx)), CREATOR_SOFIA);
    assert.equal((await miembro((tx) => getConsentCreator(tx))).id, CREATOR_LAURA);
    // Y su audiencia es solo la de Sofía, con su hueco.
    const suya = await como(USER_MIEMBRO_SOFIA, (tx) => listAccountAudience(tx));
    assert.deepEqual(suya.map((a) => a.connectionId), [CONEXION_SOFIA]);
    assert.equal(suya[0]?.gaps[0]?.requirementId, 'tt.audience.auth');
    assert.equal(suya[0]?.dimensions[0]?.buckets[0]?.absolute, 6100);
  });

  test('la identidad y los permisos de la sesión no dependen del alcance: el miembro se ve a sí mismo y su permiso', async () => {
    assert.equal((await miembro((tx) => getSessionMember(tx)))?.userId, USER_MIEMBRO);
    assert.equal(await miembro((tx) => sessionHasPermission(tx, 'conexiones.cuenta.ver')), true);
    assert.equal((await como(USER_MIEMBRO_MARCA, (tx) => getSessionMember(tx)))?.roleKey, 'manager');
  });

  test('el miembro sigue viendo las cuatro cuentas de Laura: la lista es la de la dueña menos la de Sofía', async () => {
    const todas = await duena((tx) => listAccounts(tx));
    const suyas = await miembro((tx) => listAccounts(tx));
    assert.deepEqual(suyas.map((c) => c.id).sort(), todas.filter((c) => c.id !== CONEXION_SOFIA).map((c) => c.id).sort());
    assert.equal(suyas.length, 4);
    assert.ok(todas.some((c) => c.id === CONEXION_SOFIA && c.latest?.followers === 9500), 'la dueña ve el último snapshot de Sofía');
  });

  test('las altas con ON CONFLICT no reescriben la cuenta de Sofía aunque el creador del alta sea Laura', async () => {
    const antes = await duena((tx) => findConnectionByAccount(tx, 'tiktok', EXTERNAL_ACCOUNT_SOFIA));
    assert.ok(antes, 'la cuenta de Sofía existe');
    // Conectar por OAuth la misma cuenta de TikTok, a nombre de Laura: sin el filtro en DO UPDATE, se la quitaba a Sofía.
    await assert.rejects(
      miembro((tx) => upsertConnection(tx, {
        creatorId: CREATOR_LAURA, platformId: 'tiktok', externalAccountId: EXTERNAL_ACCOUNT_SOFIA, handle: HANDLE_SOFIA, accountType: 'creator',
        secretRef: 'enc:tiktok:0000000a-0000-4000-8000-0000000000ac', ...FIRMA_TOKEN, scopes: [...FIRMA_TOKEN.scopes],
      })),
      ScopeError,
    );
    // Agregarla por @, a nombre de Laura: tampoco la reactiva ni la toca.
    await assert.rejects(
      miembro((tx) => addPublicAccount(tx, { creatorId: CREATOR_LAURA, platformId: 'tiktok', handle: HANDLE_SOFIA, externalAccountId: EXTERNAL_ACCOUNT_SOFIA, displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator' })),
      ScopeError,
    );
    const despues = await duena((tx) => listConnections(tx));
    const deSofia = despues.find((c) => c.id === CONEXION_SOFIA);
    assert.equal(deSofia?.secretRef, `public:tiktok:${HANDLE_SOFIA}`, 'el secret_ref no cambió');
    assert.deepEqual(await duena((tx) => findConnectionByAccount(tx, 'tiktok', EXTERNAL_ACCOUNT_SOFIA)), antes);
  });

  test('autorizar una cuenta por @ de Laura con un open_id que ya tiene la cuenta de Sofía: ScopeError, sin retirar la de Sofía', async () => {
    const { id } = await duena((tx) => addPublicAccount(tx, { creatorId: CREATOR_LAURA, platformId: 'tiktok', handle: 'laura.pub', externalAccountId: 'laura.pub', displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator' }));
    await assert.rejects(
      miembro((tx) => upgradePublicAccountToOAuth(tx, id, {
        externalAccountId: EXTERNAL_ACCOUNT_SOFIA, handle: 'laura.pub', accountType: 'creator', secretRef: 'enc:tiktok:0000000a-0000-4000-8000-0000000000ad', ...FIRMA_TOKEN, scopes: [...FIRMA_TOKEN.scopes],
      })),
      ScopeError,
    );
    const deSofia = await duena((tx) => findConnectionByAccount(tx, 'tiktok', EXTERNAL_ACCOUNT_SOFIA));
    assert.equal(deSofia?.deletedAt, null, 'la de Sofía sigue viva');
    await duena((tx) => disconnectConnection(tx, id));
  });

  test('una cuenta es de una creadora: con alcance por MARCA o por CAMPAÑA no hay cuentas ni perfil de creador', async () => {
    for (const userId of [USER_MIEMBRO_MARCA, USER_MIEMBRO_CAMPANA]) {
      assert.deepEqual(await como(userId, (tx) => listConnections(tx)), []);
      assert.deepEqual(await como(userId, (tx) => listAccounts(tx)), []);
      // Hay creadores en el espacio, pero ninguno en su alcance: ScopeError, no «este workspace no tiene creador».
      await assert.rejects(como(userId, (tx) => getDefaultCreatorId(tx)), ScopeError);
      await assert.rejects(como(userId, (tx) => getConsentCreator(tx)), ScopeError);
      assert.deepEqual(await como(userId, (tx) => listAccountAudience(tx)), []);
      await assert.rejects(
        como(userId, (tx) => addPublicAccount(tx, { creatorId: CREATOR_LAURA, platformId: 'instagram', handle: 'x', externalAccountId: 'x', displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator' })),
        CreatorNotInWorkspace,
      );
    }
  });
}, sembrarConexiones);
