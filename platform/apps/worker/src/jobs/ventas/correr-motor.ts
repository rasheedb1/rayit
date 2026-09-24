/**
 * Una pasada del motor de cadencias, a mano y sin el runner (VEN-10):
 *
 *   pnpm --filter @mc/worker run job:dispatch                 despacha lo vencido por los canales reales
 *   pnpm --filter @mc/worker run job:dispatch -- --canal-falso    …por el buzón en memoria: nada sale de la máquina
 *   pnpm --filter @mc/worker run job:replies                  lee los hilos abiertos y registra las respuestas
 *   … -- --workspace <uuid>                                   solo ese workspace
 *   pnpm --filter @mc/worker run job:dispatch -- --demo       el recorrido con el seed en Postgres embebido (demo-motor.ts)
 *
 * Usa la misma conexión que el worker (DATABASE_URL_DIRECT, sesión
 * estable y SET ROLE mc_worker) y las mismas funciones que los jobs
 * programados (runDispatch, runReplies), así que deja lo mismo que
 * dejaría el cron: el reclamo es atómico y correrlo dos veces no envía
 * dos veces.
 *
 * Con `--canal-falso` (o OUTREACH_CHANNELS=fake) los envíos quedan
 * registrados en outbound_touch como enviados, con el id y el hilo del
 * buzón falso; sirve para ver el motor andar contra el seed sin llaves
 * de Google ni de Unipile. Como el toque queda enviado aunque nadie lo
 * haya recibido, el comando SE NIEGA (r2) salvo que la base sea local
 * (localhost) o que se pase `--workspace` con el workspace de la demo
 * (DEMO_WORKSPACE_IDS): contra Supabase, solo así:
 *
 *   pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace 00000002-0000-4000-8000-000000000001
 *
 * Requisito en Supabase: mc_migrator miembro de mc_worker (el mismo que
 * job:seguimientos). Si no lo es, termina con «permission denied to set
 * role» y dice cómo arreglarlo.
 *
 * Salidas: 0 corrió; 1 la base dijo que no; 2 falta configuración.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EncryptedSecretStore, EnvSecretStore, InMemorySecretStore, keyringFromEnv, MasterKeyError, TokenCipher, type SecretStore } from '@mc/connectors';
import { ConfigError, loadConfig, type WorkerConfig } from '../../runner/config.ts';
import { PostgresDatabase } from '../../runner/db.ts';
import { buildChannels } from './canales/index.ts';
import { DEMO_WORKSPACE_IDS, resumenDemo, runDemoMotor } from './demo-motor.ts';
import { motorDbFromJob } from './motor-db.ts';
import { runDispatch, type DispatchReport } from './outbound.dispatch.ts';
import { runReplies, type RepliesReport } from './outbound.replies.ts';

type Pasada = 'dispatch' | 'replies';

interface Opciones {
  pasada: Pasada;
  canalFalso: boolean;
  /** Postgres embebido con el seed, canal falso: no toca ninguna base compartida. */
  demo: boolean;
  workspaceId: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee los argumentos. Lanza ConfigError con el uso si algo no cuadra. */
export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Opciones {
  // pnpm pasa el «--» que separa sus argumentos de los del comando.
  const [pasada, ...resto] = argv.filter((a) => a !== '--');
  if (pasada !== 'dispatch' && pasada !== 'replies') {
    throw new ConfigError('Uso: correr-motor.ts dispatch|replies [--canal-falso] [--workspace <uuid>] [--demo]');
  }
  let workspaceId: string | undefined;
  let canalFalso = env['OUTREACH_CHANNELS'] === 'fake';
  let demo = false;
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a === '--canal-falso') canalFalso = true;
    else if (a === '--demo') demo = true;
    else if (a === '--workspace') {
      const v = resto[++i];
      if (!v || !UUID.test(v)) throw new ConfigError('--workspace pide el uuid de un workspace.');
      workspaceId = v;
    } else throw new ConfigError(`Argumento desconocido: ${a}`);
  }
  if (demo && pasada !== 'dispatch') throw new ConfigError('--demo solo existe para dispatch.');
  return { pasada, canalFalso: canalFalso || demo, demo, workspaceId };
}

/** ¿La base es de esta máquina? (localhost, 127.0.0.1, ::1 o un socket). */
export function isLocalDatabase(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  } catch {
    return false;
  }
}

/**
 * El canal falso marca como enviados mensajes que nadie recibió y avanza
 * las cadencias: contra una base compartida, solo sobre el workspace de
 * la demo. Lanza ConfigError si no.
 */
export function assertFakeAllowed(o: Pick<Opciones, 'canalFalso' | 'demo' | 'workspaceId'>, databaseUrl: string | null | undefined): void {
  if (!o.canalFalso || o.demo || isLocalDatabase(databaseUrl)) return;
  if (o.workspaceId && (DEMO_WORKSPACE_IDS as readonly string[]).includes(o.workspaceId)) return;
  throw new ConfigError(
    'El canal falso deja como enviados mensajes que nadie recibió. Contra una base que no es local, solo con ' +
      `--workspace de la demo (${DEMO_WORKSPACE_IDS.join(', ')}).`,
  );
}

/** El almacén de tokens de las cuentas de envío, igual que el worker. El canal falso no lee tokens. */
function secretStore(config: WorkerConfig, db: PostgresDatabase, canalFalso: boolean): SecretStore {
  if (canalFalso || config.secretStore === 'memory') return new InMemorySecretStore();
  if (config.secretStore === 'env') return new EnvSecretStore();
  try {
    return new EncryptedSecretStore({ db, cipher: new TokenCipher(keyringFromEnv(process.env)) });
  } catch (err) {
    if (err instanceof MasterKeyError) {
      throw new ConfigError(`${err.message} Para una pasada sin canales reales: --canal-falso.`);
    }
    throw err;
  }
}

export function resumenDespacho(r: DispatchReport): string {
  const lineas = [
    `Despacho: ${r.claim.claimed} reclamado(s), ${r.sent.length} enviado(s), ${r.retried.length} a reintento, ${r.failed.length} fallido(s).`,
    `  Reprogramados por tope: ${r.claim.rescheduled.length}. Fuera de la ventana: ${r.claim.outsideWindow.length}. ` +
      `Esperando cuenta: ${r.claim.waitingAccount.length + r.waiting.length}. Retenidos: ${r.held.length}. Pospuestos: ${r.postponed.length}.`,
    `  Cancelados: ${r.canceled.length + r.claim.canceledOptedOut + r.claim.canceledFinished}. ` +
      `Zombis: ${r.zombies.failed} a fallido, ${r.zombies.released} devuelto(s) a la cola. Sin intentar, de vuelta: ${r.released.length}.`,
  ];
  if (r.confirmed.length) lineas.push(`  Intentos ambiguos que sí habían salido (no se reenviaron): ${r.confirmed.length}.`);
  for (const w of r.warnings) lineas.push(`  · ${w.touchId} enviado con aviso: ${w.warning}`);
  for (const e of r.errors) lineas.push(`  · ${e.touchId} error: ${e.error}`);
  if (r.notConfigured.length) lineas.push(`  Canales no configurados (sus toques esperan): ${r.notConfigured.join(', ')}.`);
  for (const c of r.canceled) lineas.push(`  · ${c.touchId} cancelado: ${c.reason}`);
  for (const c of r.postponed) lineas.push(`  · ${c.touchId} pospuesto: ${c.reason}`);
  for (const c of r.held) lineas.push(`  · ${c.touchId} retenido: ${c.reason}`);
  return `${lineas.join('\n')}\n`;
}

export function resumenRespuestas(r: RepliesReport): string {
  const lineas = [
    `Respuestas: ${r.threads} hilo(s) abierto(s), ${r.inbound} mensaje(s) nuevo(s), ${r.optOuts} baja(s), ${r.canceled} toque(s) cancelado(s).`,
  ];
  for (const u of r.unreadable) lineas.push(`  · ${u.channel} ${u.threadRef} sin leer: ${u.error}`);
  return `${lineas.join('\n')}\n`;
}

async function main(): Promise<void> {
  const debug = Boolean(process.env['DEBUG']);
  let opciones: Opciones;
  let config: WorkerConfig;
  let db: PostgresDatabase;
  try {
    opciones = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  if (opciones.demo) {
    try {
      process.stdout.write(resumenDemo(await runDemoMotor()));
    } catch (err) {
      process.stderr.write(`La demo del motor no corrió: ${err instanceof Error ? err.message : String(err)}\n`);
      if (debug && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    config = loadConfig(process.env, { mode: 'postgres' });
    assertFakeAllowed(opciones, config.databaseUrl);
    db = new PostgresDatabase({
      connectionString: config.databaseUrl!,
      setRole: config.setRole,
      jobPoolMax: 1,
      bossPoolMax: 1,
      applicationName: `mc-worker:outbound.${opciones.pasada}`,
      sslRootCert: config.sslRootCert,
    });
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const channels = buildChannels({
      env: process.env, secrets: secretStore(config, db, opciones.canalFalso), mode: opciones.canalFalso ? 'fake' : 'real',
    });
    if (channels.mode === 'fake') process.stdout.write('Canal falso: nada sale de la máquina.\n');
    const motor = motorDbFromJob(db);
    const now = () => new Date();
    if (opciones.pasada === 'dispatch') {
      const r = await runDispatch(motor, { senders: channels.senders, appUrl: channels.appUrl, now, workspaceId: opciones.workspaceId });
      process.stdout.write(resumenDespacho(r));
    } else {
      const r = await runReplies(motor, { readers: channels.readers, now, workspaceId: opciones.workspaceId });
      process.stdout.write(resumenRespuestas(r));
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    process.stderr.write(`El motor no corrió: ${mensaje}\n`);
    if (err instanceof ConfigError) process.exitCode = 2;
    else process.exitCode = 1;
    if (/set role/i.test(mensaje)) {
      process.stderr.write('Falta: ./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"\n');
    }
    if (debug && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  } finally {
    await db.close().catch(() => undefined);
  }
}

// Solo corre como comando; las pruebas importan parseArgs y los resúmenes.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
