/**
 * ACC-6 · Alcance en queries/conexiones.ts: un miembro con alcance a
 * Laura no ve las cuentas, consentimientos ni snapshots de Sofía en
 * NINGUNA función exportada, y no puede conectar, desconectar ni anotar
 * nada de Sofía. Ver test/alcance.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as conexiones from '../src/queries/conexiones.ts';
import {
  CONEXION_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, definirPruebasDeAlcance, EXTERNAL_ACCOUNT_SOFIA, HANDLE_SOFIA,
  USER_MIEMBRO_CAMPANA, USER_MIEMBRO_MARCA, type CasoDeAlcance,
} from './alcance.ts';

const {
  listConnections, findConnectionByAccount, getDefaultCreatorId, listConsents, upsertConnection, recordConsent,
  disconnectConnection, addPublicAccount, recordAccountSnapshot, listAccounts, markAccountLookupFailure,
  findPublicAccountByHandle, upgradePublicAccountToOAuth, ConnectionNotFound, CreatorNotInWorkspace, NoCreatorProfile,
} = conexiones;

const HOY = new Date().toISOString().slice(0, 10);

const CASOS: Record<string, CasoDeAlcance> = {
  listConnections: { run: (tx) => listConnections(tx), duena: 'nombra', miembro: 'nada' },
  listAccounts: { run: (tx) => listAccounts(tx), duena: 'nombra', miembro: 'nada' },
  findConnectionByAccount: { run: (tx) => findConnectionByAccount(tx, 'tiktok', EXTERNAL_ACCOUNT_SOFIA), duena: 'nombra', miembro: 'nada' },
  findPublicAccountByHandle: { run: (tx) => findPublicAccountByHandle(tx, 'tiktok', HANDLE_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Para las dos es Laura (la más antigua; para el miembro, la única de su alcance).
  getDefaultCreatorId: { run: (tx) => getDefaultCreatorId(tx), duena: (r) => r === CREATOR_LAURA, miembro: 'nada' },
  listConsents: { run: (tx) => listConsents(tx, CONEXION_SOFIA), duena: 'nombra', miembro: 'nada' },
  recordAccountSnapshot: {
    run: (tx) => recordAccountSnapshot(tx, { connectionId: CONEXION_SOFIA, day: HOY, followers: 9600, following: 100, mediaCount: 43, views: 530000, raw: {} }),
    duena: (r) => r === 'guardada',
    miembro: { rechaza: ConnectionNotFound },
  },
  markAccountLookupFailure: {
    run: (tx) => markAccountLookupFailure(tx, CONEXION_SOFIA, 'Sin métricas públicas.', false),
    duena: 'pasa',
    miembro: { rechaza: ConnectionNotFound },
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

definirPruebasDeAlcance('conexiones', conexiones, CASOS, ({ duena, miembro, como }) => {
  test('el miembro sigue viendo las cuatro cuentas de Laura: la lista es la de la dueña menos la de Sofía', async () => {
    const todas = await duena((tx) => listAccounts(tx));
    const suyas = await miembro((tx) => listAccounts(tx));
    assert.deepEqual(suyas.map((c) => c.id).sort(), todas.filter((c) => c.id !== CONEXION_SOFIA).map((c) => c.id).sort());
    assert.equal(suyas.length, 4);
    assert.ok(todas.some((c) => c.id === CONEXION_SOFIA && c.latest?.followers === 9500), 'la dueña ve el último snapshot de Sofía');
  });

  test('una cuenta es de una creadora: con alcance por MARCA o por CAMPAÑA no hay cuentas ni perfil de creador', async () => {
    for (const userId of [USER_MIEMBRO_MARCA, USER_MIEMBRO_CAMPANA]) {
      assert.deepEqual(await como(userId, (tx) => listConnections(tx)), []);
      assert.deepEqual(await como(userId, (tx) => listAccounts(tx)), []);
      await assert.rejects(como(userId, (tx) => getDefaultCreatorId(tx)), NoCreatorProfile);
      await assert.rejects(
        como(userId, (tx) => addPublicAccount(tx, { creatorId: CREATOR_LAURA, platformId: 'instagram', handle: 'x', externalAccountId: 'x', displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator' })),
        CreatorNotInWorkspace,
      );
    }
  });
});
