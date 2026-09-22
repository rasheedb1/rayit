/** HttpCore con fetch de fixtures, reloj falso y log en memoria, para las pruebas de OAuth. */
import { HttpCore } from '../../src/http/client.ts';
import { InMemoryCallLogSink } from '../../src/log/memory.ts';
import { QuotaManager } from '../../src/quota/manager.ts';
import type { OAuthAppConfig, OAuthProviderId } from '../../src/oauth/types.ts';
import { FixtureFetch, loadFixtures } from '../../src/testing/fixture-fetch.ts';
import { FakeClock } from './fake-clock.ts';

export const NOW = new Date('2026-09-22T10:00:00Z');

export function appConfig(provider: OAuthProviderId, scopes: readonly string[]): OAuthAppConfig {
  return { provider, clientId: `client-id-${provider}`, clientSecret: `CLIENT-SECRET-${provider}-SECRETO`, redirectUri: `https://on-cue-web.vercel.app/conexiones/oauth/${provider}/callback`, scopes };
}

export async function oauthCore(platformDir: string, names: ReadonlyArray<[string, string?]>) {
  const clock = new FakeClock(NOW.getTime());
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures(platformDir, names));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, fetch, core };
}

/** Todo lo que una prueba de OAuth debe afirmar que NO aparece en errores ni en el log. */
export function assertNoSecrets(texts: readonly string[], secrets: readonly string[]): string | null {
  for (const t of texts) for (const s of secrets) if (s && t.includes(s)) return `«${s.slice(0, 12)}…» apareció en: ${t.slice(0, 120)}`;
  return null;
}
