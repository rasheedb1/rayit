/**
 * Regraba fixtures con un token real, anonimizando ids y handles.
 *
 *   pnpm --filter @mc/connectors record -- --platform tiktok --ref env:TIKTOK_DEMO
 *   pnpm --filter @mc/connectors record -- --platform youtube --ref env:YOUTUBE_DEMO --handle NutriveOficial
 *   pnpm --filter @mc/connectors record -- --platform tiktok-accounts --ref env:TIKTOK_BUSINESS_DEMO --business-id <open_id>
 *   pnpm --filter @mc/connectors record -- --platform instagram --ref env:INSTAGRAM_DEMO --brand cafealma
 *
 * El token se lee por EnvSecretStore (variable con JSON de OAuthTokens,
 * ver secret-store.ts) y NUNCA se escribe: las cabeceras no se guardan y
 * el cuerpo pasa por el anonimizador antes de tocar el disco. Sobrescribe
 * los casos `ok` (y `paginated` cuando hay más de una página) con
 * meta.source = 'recorded'; los casos de error siguen saliendo de la
 * documentación. Sale con código 2 si falta un argumento o el token.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpCore, type FetchLike } from '../src/http/client.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { EnvSecretStore } from '../src/secret-store.ts';
import { InstagramClient } from '../src/platforms/instagram-api.ts';
import { TikTokAccountsClient } from '../src/platforms/tiktok-accounts.ts';
import { TikTokDisplayClient } from '../src/platforms/tiktok-display.ts';
import { YouTubeClient } from '../src/platforms/youtube-api.ts';
import { FIXTURES_DIR, type Fixture, type FixtureResponse } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';

interface Args {
  platform: string;
  ref: string;
  handle?: string;
  brand?: string;
  businessId?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  if (!out['platform'] || !out['ref']) fail('Uso: record --platform <tiktok|tiktok-accounts|instagram|youtube> --ref env:NOMBRE [--handle x] [--brand x] [--business-id x]');
  return { platform: out['platform'], ref: out['ref'], handle: out['handle'], brand: out['brand'], businessId: out['business-id'] };
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

/** Ids, handles y URLs firmadas se reemplazan por valores estables pero ficticios. */
function anonymize(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const sec of secrets) if (sec.length >= 8) s = s.split(sec).join('[REDACTADO]');
    if (/^\d{15,}$/.test(s)) return `9${createHash('sha256').update(s).digest('hex').replace(/\D/g, '').slice(0, 18)}`;
    if (/^UC[\w-]{22}$/.test(s)) return `UC${createHash('sha256').update(s).digest('base64url').slice(0, 22)}`;
    if (/x-signature=|x-expires=|oh=|oe=/.test(s)) return s.replace(/\?.*$/, '?[firma-omitida]');
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => anonymize(v, secrets));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /username|handle|display_name|customUrl|title|name$/i.test(k) && typeof v === 'string' ? `demo-${createHash('sha256').update(v).digest('hex').slice(0, 6)}` : anonymize(v, secrets);
    }
    return out;
  }
  return value;
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  response: FixtureResponse;
}

/** fetch real que además guarda cada respuesta (sin cabeceras de petición). */
function recordingFetch(store: Recorded[]): FetchLike {
  return async (url, init) => {
    const res = await globalThis.fetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* texto plano */
    }
    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'retry-after']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    store.push({ method: (init.method ?? 'GET').toUpperCase(), url, body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined, response: { status: res.status, headers, body } });
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

async function write(platform: string, endpoint: string, caso: string, calls: Recorded[], secrets: string[], notes: string): Promise<void> {
  if (calls.length === 0) return;
  const first = calls[0]!;
  const urlPattern = '^' + first.url.replace(/\?.*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (first.url.includes('?') ? '\\?' : '');
  const fixture: Fixture = {
    meta: { source: 'recorded', recordedAt: new Date().toISOString().slice(0, 10), notes },
    request: { method: first.method, urlPattern, ...(first.body !== undefined ? { body: anonymize(first.body, secrets) } : {}) },
    response: calls.length === 1
      ? { ...first.response, body: anonymize(first.response.body, secrets) }
      : calls.map((c) => ({ ...c.response, body: anonymize(c.response.body, secrets) })),
  };
  const dir = join(FIXTURES_DIR, platform);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${endpoint}.${caso}.json`);
  await writeFile(path, JSON.stringify(fixture, null, 2) + '\n');
  process.stdout.write(`grabado ${path} (${calls.length} respuesta(s))\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tokens: OAuthTokens | null = await new EnvSecretStore().get(args.ref);
  if (!tokens) fail(`No hay credenciales en ${args.ref}. La variable debe traer el JSON de OAuthTokens (ver src/secret-store.ts).`);
  const secrets = [tokens.accessToken, tokens.refreshToken ?? ''];
  const calls: Recorded[] = [];
  const core = new HttpCore({ callLog: new InMemoryCallLogSink(), quota: new QuotaManager(), fetch: recordingFetch(calls) });
  const auth = { connectionId: null, tokens };
  const take = (): Recorded[] => calls.splice(0, calls.length);
  const notes = `Grabado con un token real y anonimizado por scripts/record.ts.`;

  switch (args.platform) {
    case 'tiktok': {
      const api = new TikTokDisplayClient(core, auth);
      await api.userInfo();
      await write('tiktok', 'user.info', 'ok', take(), secrets, notes);
      const pages = [];
      for await (const p of api.iterateVideos({ maxPages: 2 })) pages.push(p);
      await write('tiktok', 'video.list', pages.length > 1 ? 'paginated' : 'ok', take(), secrets, notes);
      const ids = pages.flatMap((p) => p.data.items.map((v) => v.post.external_post_id)).slice(0, 2);
      if (ids.length > 0) {
        await api.queryVideos(ids);
        await write('tiktok', 'video.query', 'ok', take(), secrets, notes);
      }
      break;
    }
    case 'tiktok-accounts': {
      if (!args.businessId) fail('--business-id es obligatorio para tiktok-accounts');
      const api = new TikTokAccountsClient(core, auth, args.businessId);
      await api.accountInfo();
      await write('tiktok-accounts', 'business.get', 'ok', take(), secrets, notes);
      const pages = [];
      for await (const p of api.iterateVideos({ maxPages: 2 })) pages.push(p);
      await write('tiktok-accounts', 'business.video.list', pages.length > 1 ? 'paginated' : 'ok', take(), secrets, notes);
      break;
    }
    case 'instagram': {
      const api = new InstagramClient(core, auth);
      await api.me();
      await write('instagram', 'me', 'ok', take(), secrets, notes);
      const pages = [];
      for await (const p of api.iterateMedia({ maxPages: 2, limit: 3 })) pages.push(p);
      await write('instagram', 'media.list', pages.length > 1 ? 'paginated' : 'ok', take(), secrets, notes);
      const reel = pages.flatMap((p) => p.data.items).find((m) => m.post.surface === 'reels');
      if (reel) {
        await api.mediaInsights(reel.post.external_post_id, 'REELS');
        await write('instagram', 'media.insights', 'reels.ok', take(), secrets, notes);
      }
      await api.audienceDemographics('followers', 'age').catch(() => undefined);
      await write('instagram', 'account.demographics', calls[0]?.response.status === 200 ? 'age.ok' : 'insufficient', take(), secrets, notes);
      if (args.brand) {
        await api.businessDiscovery(args.brand);
        await write('instagram', 'business_discovery', 'ok', take(), secrets, notes);
      }
      break;
    }
    case 'youtube': {
      const api = new YouTubeClient(core, auth);
      const ch = await api.channelMine();
      await write('youtube', 'channels.list', 'mine.ok', take(), secrets, notes);
      if (ch.data?.uploadsPlaylistId) {
        const pages = [];
        for await (const p of api.iterateUploads(ch.data.uploadsPlaylistId, { maxPages: 2, maxResults: 3 })) pages.push(p);
        await write('youtube', 'playlist_items.list', pages.length > 1 ? 'paginated' : 'ok', take(), secrets, notes);
        const ids = pages.flatMap((p) => p.data.items.map((i) => i.videoId)).slice(0, 2);
        if (ids.length > 0) {
          await api.videosById(ids);
          await write('youtube', 'videos.list', 'ok', take(), secrets, notes);
        }
      }
      if (args.handle) {
        await api.channelByHandle(args.handle);
        await write('youtube', 'channels.list', 'handle.ok', take(), secrets, notes);
      }
      break;
    }
    default:
      fail(`Plataforma desconocida: ${args.platform}`);
  }
}

main().catch((err: unknown) => {
  // Un PlatformApiError ya viene sin token; cualquier otro error se imprime sin cause.
  process.stderr.write(`falló la grabación: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
