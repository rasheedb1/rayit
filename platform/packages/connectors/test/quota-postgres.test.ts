/**
 * UPSERT de api_quota_usage sobre los dos índices únicos parciales
 * (con y sin connection_id), corrido dos veces → una fila con units_used sumado.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { PostgresQuotaUsageStore } from '../src/quota/postgres.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { PostgresCallLogSink } from '../src/log/postgres.ts';
import { CONNECTION_TIKTOK, CONNECTION_YOUTUBE, executor, openMigratedPglite, seedConnections } from './helpers/pglite.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let db: PGlite;
before(async () => {
  db = await openMigratedPglite();
  await seedConnections(db);
});
after(async () => { await db.close(); });

interface UsageRow extends Record<string, unknown> { platform_id: string; connection_id: string | null; day: string; units_used: string | number; units_limit: string | number | null; calls: string | number }

async function usage(): Promise<UsageRow[]> {
  const res = await db.query<UsageRow>('SELECT platform_id, connection_id, day::text AS day, units_used, units_limit, calls FROM api_quota_usage ORDER BY platform_id, connection_id NULLS FIRST');
  return res.rows;
}

test('cuota de app (connection_id nulo, YouTube): dos UPSERT → una fila sumada', async () => {
  const store = new PostgresQuotaUsageStore(executor(db));
  await store.add('youtube', null, '2026-09-22', 3, 1, 10_000);
  await store.add('youtube', null, '2026-09-22', 5, 2, 10_000);
  const rows = (await usage()).filter((r) => r.platform_id === 'youtube');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.connection_id, null);
  assert.equal(Number(rows[0]!.units_used), 8);
  assert.equal(Number(rows[0]!.calls), 3);
  assert.equal(Number(rows[0]!.units_limit), 10_000);
  assert.deepEqual(await store.load('youtube', null, '2026-09-22'), { unitsUsed: 8, calls: 3 });
  assert.equal(await store.load('youtube', null, '2026-09-23'), null);
});

test('cuota por conexión (TikTok): dos UPSERT → una fila sumada, y otra conexión es otra fila', async () => {
  const store = new PostgresQuotaUsageStore(executor(db));
  await store.add('tiktok', CONNECTION_TIKTOK, '2026-09-22', 1, 1, null);
  await store.add('tiktok', CONNECTION_TIKTOK, '2026-09-22', 1, 1, null);
  await store.add('youtube', CONNECTION_YOUTUBE, '2026-09-22', 2, 1, null);
  const rows = (await usage()).filter((r) => r.connection_id !== null);
  assert.equal(rows.length, 2);
  const tiktok = rows.find((r) => r.platform_id === 'tiktok')!;
  assert.equal(tiktok.connection_id, CONNECTION_TIKTOK);
  assert.equal(Number(tiktok.units_used), 2);
  assert.equal(Number(tiktok.calls), 2);
  assert.equal(tiktok.units_limit, null);
  assert.deepEqual(await store.load('tiktok', CONNECTION_TIKTOK, '2026-09-22'), { unitsUsed: 2, calls: 2 });
});

test('el QuotaManager siembra el día desde la tabla: un proceso nuevo no parte de cero', async () => {
  const clock = new FakeClock();
  const store = new PostgresQuotaUsageStore(executor(db));
  const m1 = new QuotaManager({ now: clock.now, sleep: clock.sleep, store });
  const key = { family: 'youtube' as const, platformId: 'youtube' as const, connectionId: null, endpoint: 'youtube.videos.list' };
  await m1.acquire(key, 9_000);
  const m2 = new QuotaManager({ now: clock.now, sleep: clock.sleep, store });
  await m2.acquire(key, 900);
  const err = await m2.acquire(key, 200).then(() => null, (e: unknown) => e as { kind?: string });
  assert.equal(err?.kind, 'quota', '8 + 9000 + 900 ya usados; 200 más no caben en 10 000');
  const row = await store.load('youtube', null, '2026-09-22');
  assert.equal(row!.unitsUsed, 8 + 9_000 + 900);
});

test('api_call_log: PostgresCallLogSink deja la fila con todas las columnas', async () => {
  const sink = new PostgresCallLogSink(executor(db));
  await sink.record({ connection_id: CONNECTION_TIKTOK, platform_id: 'tiktok', endpoint: 'tiktok.video.list', http_status: 429, ok: false, error_code: 'rate_limit_exceeded', error_message: 'slow down', request_units: 1, duration_ms: 12, rate_limited: true, retry_after_s: 7 });
  const res = await db.query<Record<string, unknown>>('SELECT * FROM api_call_log WHERE endpoint = $1', ['tiktok.video.list']);
  assert.equal(res.rows.length, 1);
  const row = res.rows[0]!;
  assert.equal(row['connection_id'], CONNECTION_TIKTOK);
  assert.equal(row['http_status'], 429);
  assert.equal(row['rate_limited'], true);
  assert.equal(row['retry_after_s'], 7);
  assert.equal(row['request_units'], 1);
});

test('solo la familia principal de cada plataforma persiste: youtube-analytics no toca la fila de youtube', async () => {
  const clock = new FakeClock();
  const store = new PostgresQuotaUsageStore(executor(db));
  const before = await store.load('youtube', null, '2026-09-22');
  const m = new QuotaManager({ now: clock.now, sleep: clock.sleep, store });
  await m.acquire({ family: 'youtube-analytics', platformId: 'youtube', connectionId: null, endpoint: 'youtube.analytics.query' }, 1);
  await m.acquire({ family: 'youtube-search', platformId: 'youtube', connectionId: null, endpoint: 'youtube.search.list' }, 1);
  const after = await store.load('youtube', null, '2026-09-22');
  assert.deepEqual(after, before, 'la fila de la Data API no cambió');
  assert.deepEqual(m.usedToday({ family: 'youtube-search', platformId: 'youtube', connectionId: null }), { unitsUsed: 1, calls: 1 }, 'en memoria sí cuenta');
});
