/** Caso 6 de CON-2 · Fase 5: el redactor del logger. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OAuthTokens } from '@mc/connectors';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { loadConfig, usesTransactionPooler } from '../src/runner/config.ts';

const tokens: OAuthTokens = {
  accessToken: 'ACCESO-SECRETO-1',
  refreshToken: 'REFRESCO-SECRETO-2',
  accessExpiresAt: new Date('2026-09-22T10:00:00Z'),
  scopes: ['a'],
};

test('6 · el redactor oculta accessToken y refreshToken, y tapa un OAuthTokens entero', () => {
  const sink = new MemorySink();
  const log = createLogger({ sink, now: () => new Date('2026-09-21T12:00:00Z'), bindings: { job: 'oauth.refresh' } });
  log.info('renovando', { tokens, accessToken: 'SUELTO-3', refresh_token: 'SUELTO-4', secret_ref: 'vault:1', anidado: { authorization: 'Bearer X' } });

  const line = sink.lines[0]!;
  for (const secreto of ['ACCESO-SECRETO-1', 'REFRESCO-SECRETO-2', 'SUELTO-3', 'SUELTO-4', 'Bearer X']) {
    assert.ok(!line.includes(secreto), `se filtró ${secreto}`);
  }
  const rec = JSON.parse(line) as Record<string, unknown>;
  assert.equal(rec['time'], '2026-09-21T12:00:00.000Z');
  assert.equal(rec['level'], 'info');
  assert.equal(rec['msg'], 'renovando');
  assert.equal(rec['job'], 'oauth.refresh');
  assert.equal(rec['tokens'], '[OAuthTokens REDACTADO]');
  assert.equal(rec['accessToken'], '[REDACTADO]');
  assert.equal(rec['refresh_token'], '[REDACTADO]');
  assert.equal(rec['secret_ref'], 'vault:1');
  assert.deepEqual(rec['anidado'], { authorization: '[REDACTADO]' });
});

test('una línea por evento, JSON válido, con nivel mínimo y logger hijo', () => {
  const sink = new MemorySink();
  const log = createLogger({ sink, level: 'info' });
  log.debug('no sale');
  const child = log.child({ runId: 7 });
  child.warn('sale', { durationMs: 12, err: new Error('x') });
  assert.equal(sink.lines.length, 1);
  const rec = sink.records()[0]!;
  assert.equal(rec['runId'], 7);
  assert.equal(rec['durationMs'], 12);
  assert.equal((rec['err'] as Record<string, unknown>)['message'], 'x');
  assert.ok(typeof (rec['err'] as Record<string, unknown>)['stack'] === 'string');
});

test('valores raros no rompen la serialización', () => {
  const sink = new MemorySink();
  const log = createLogger({ sink });
  const circular: Record<string, unknown> = { a: 1 };
  circular['self'] = circular;
  log.info('raro', { big: 10n, circular, fecha: new Date(0), nada: undefined });
  const rec = sink.records()[0]!;
  assert.equal(rec['big'], '10');
  assert.deepEqual(rec['circular'], { a: 1, self: '[circular]' });
  assert.equal(rec['fecha'], '1970-01-01T00:00:00.000Z');
  assert.ok(!('nada' in rec));
});

test('formato pretty para desarrollo', () => {
  const sink = new MemorySink();
  const log = createLogger({ sink, format: 'pretty', now: () => new Date('2026-09-21T12:34:56Z') });
  log.error('falló', { job: 'x', accessToken: 'S' });
  assert.equal(sink.lines[0], '12:34:56 ERROR falló  job=x accessToken=[REDACTADO]');
});

test('config: exige DATABASE_URL_DIRECT en modo Postgres y rechaza el pooler de transacción', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL_DIRECT/);
  assert.throws(() => loadConfig({ DATABASE_URL_DIRECT: 'postgres://u:p@host:6543/db' }), /6543/);
  assert.equal(usesTransactionPooler('postgres://u:p@host:6543/db?sslmode=require'), true);
  assert.equal(usesTransactionPooler('postgres://u:p@host:5432/db'), false);
  const cfg = loadConfig({ DATABASE_URL_DIRECT: 'postgres://u:p@host:5432/db', WORKER_GROUPS: 'collect, connections', WORKER_SET_ROLE: '' });
  assert.deepEqual(cfg.groups, ['collect', 'connections']);
  assert.equal(cfg.setRole, null);
  assert.equal(loadConfig({ DATABASE_URL_DIRECT: 'postgres://u:p@host:5432/db' }).setRole, 'mc_worker');
  assert.equal(loadConfig({ WORKER_DATABASE_URL: 'postgres://w:p@host:5432/db', DATABASE_URL_DIRECT: 'postgres://m:p@host:5432/db' }).databaseUrl, 'postgres://w:p@host:5432/db');
  assert.throws(() => loadConfig({ DATABASE_URL_DIRECT: 'postgres://u:p@host:5432/db', WORKER_POLL_S: '0.1' }), /WORKER_POLL_S/);
  assert.equal(loadConfig({}, { mode: 'pglite' }).databaseUrl, null);
});
