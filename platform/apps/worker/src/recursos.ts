/**
 * Lo que necesita cualquier forma de correr el worker además de la base:
 * el almacén de secretos y los refreshers de OAuth. Lo usan el proceso
 * largo y --once (src/index.ts) y el modo por turnos (src/tick.ts, que
 * corre dentro de la web): una sola definición, para que el turno no
 * descifre tokens ni renueve credenciales de otra manera.
 */
import {
  createInstagramRefresher, createTikTokRefresher, createYouTubeRefresher, EncryptedSecretStore, EnvSecretStore, FakeTokenRefresher, HttpCore,
  InMemorySecretStore, keyringFromEnv, loadOAuthApps, MasterKeyError, NULL_CALL_LOG, PLATFORM_IDS, refresherRegistry, TokenCipher,
  type SecretStore, type TokenRefresherRegistry,
} from '@mc/connectors';
import { ConfigError, type Env, type WorkerConfig } from './runner/config.ts';
import type { WorkerDatabase } from './runner/db.ts';
import type { Logger } from './runner/logger.ts';

/**
 * El almacén real (CON-3): connection_secret cifrado con TOKEN_ENCRYPTION_KEY,
 * leído y escrito con la conexión del worker (mc_worker). Sin la clave el
 * worker no arranca: un refresher que no puede leer tokens no sirve de nada.
 */
export function buildSecrets(config: WorkerConfig, db: WorkerDatabase, logger: Logger, env: Env): SecretStore {
  if (config.secretStore === 'memory') return new InMemorySecretStore();
  if (config.secretStore === 'env') {
    logger.warn('SECRET_STORE=env: los tokens salen de variables de entorno. Solo para desarrollo.');
    return new EnvSecretStore();
  }
  try {
    return new EncryptedSecretStore({ db, cipher: new TokenCipher(keyringFromEnv(env)) });
  } catch (err) {
    if (err instanceof MasterKeyError) throw new ConfigError(`${err.message} Para desarrollo sin clave: SECRET_STORE=memory o env.`);
    throw err;
  }
}

export interface RefresherOptions {
  /**
   * Nivel del aviso «app OAuth sin configurar». El proceso largo lo da
   * una vez al arrancar (warn); un turno arranca cada minuto y lo
   * repetiría sin parar, así que lo baja a debug.
   */
  missingAppsLevel?: 'warn' | 'debug';
}

export function buildRefreshers(config: WorkerConfig, logger: Logger, env: Env, opts: RefresherOptions = {}): TokenRefresherRegistry {
  if (config.tokenRefresher === 'fake') {
    logger.warn('TOKEN_REFRESHER=fake: los tokens se "renuevan" con un refresher falso. Solo para desarrollo.');
    return refresherRegistry(PLATFORM_IDS.map((p) => new FakeTokenRefresher(p)));
  }
  // TikTok e Instagram (CON-3) y YouTube (CON-8) reales, sobre el cliente HTTP de CON-1.
  // El sink es nulo porque el job oauth.refresh escribe su propia fila en api_call_log.
  const { apps, missing } = loadOAuthApps(env);
  for (const [provider, vars] of Object.entries(missing)) {
    logger[opts.missingAppsLevel ?? 'warn']('app OAuth sin configurar: sus tokens no se podrán renovar', { provider, missing: vars });
  }
  const core = new HttpCore({ callLog: NULL_CALL_LOG, logger, retry: { maxRetries: 1 } });
  return refresherRegistry([
    createTikTokRefresher(core, { login: apps.tiktok, business: apps['tiktok-business'] }),
    createInstagramRefresher(core, apps.instagram),
    createYouTubeRefresher(core, apps.youtube),
  ]);
}
