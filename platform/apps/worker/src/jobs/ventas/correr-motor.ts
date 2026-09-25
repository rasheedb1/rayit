/**
 * Una pasada del motor de cadencias, a mano y sin el runner (VEN-10):
 *
 *   pnpm --filter @mc/worker run job:dispatch                     despacha lo vencido por los canales reales
 *   pnpm --filter @mc/worker run job:dispatch -- --canal-falso    …por el buzón en memoria: nada sale de la máquina
 *   pnpm --filter @mc/worker run job:replies                      lee los hilos abiertos y registra las respuestas
 *   … -- --workspace <uuid>                                       solo ese workspace
 *   pnpm --filter @mc/worker run job:dispatch -- --demo           el recorrido con el seed en Postgres embebido (demo-motor.ts)
 *
 * Y para demostrar el motor contra la base de verdad con el workspace de
 * la demo (docs/ventas-outreach.md §5.2), un comando por paso:
 *
 *   … job:dispatch -- --preparar-demo --workspace <demo>   deja la demo como --demo, con el reloj de verdad y el envío apagado
 *   … job:dispatch -- --canal-falso --workspace <demo>     apagado: no sale nada
 *   … job:dispatch -- --encender --workspace <demo>        enciende el envío de la demo (enableOutreach)
 *   … job:dispatch -- --canal-falso --workspace <demo>     encendido: sale el mensaje de LinkedIn del seed
 *
 * Usa la misma conexión que el worker (DATABASE_URL_DIRECT, sesión
 * estable y SET ROLE mc_worker) y las mismas funciones que los jobs
 * programados (runDispatch, runReplies), así que deja lo mismo que
 * dejaría el cron: el reclamo es atómico y correrlo dos veces no envía
 * dos veces.
 *
 * Con `--canal-falso` (o OUTREACH_CHANNELS=fake) los envíos quedan
 * registrados en outbound_touch como enviados, con el id y el hilo del
 * buzón falso. Como el toque queda enviado aunque nadie lo haya
 * recibido, el comando se niega fuera de lo que permite fakeAllowed (la
 * misma regla del worker programado): contra Supabase, solo con
 * `--workspace` de la demo. `--preparar-demo` y `--encender` solo existen
 * para los workspaces de la demo.
 *
 * Requisito en Supabase: mc_migrator miembro de mc_worker (el mismo que
 * job:seguimientos). Si no lo es, termina con «permission denied to set
 * role» y dice cómo arreglarlo.
 *
 * Salidas: 0 corrió; 1 la base dijo que no; 2 falta configuración.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EncryptedSecretStore, EnvSecretStore, InMemorySecretStore, keyringFromEnv, MasterKeyError, PostgresOutreachCallLog, TokenCipher, type SecretStore,
} from '@mc/connectors';
import { enableOutreach } from '@mc/db/queries/outreach';
import { ConfigError, loadConfig, type WorkerConfig } from '../../runner/config.ts';
import { PostgresDatabase } from '../../runner/db.ts';
import { buildChannels, fakeAllowed, fakeRefusal } from './canales/index.ts';
import { DEMO_WORKSPACE_IDS } from './demo-ids.ts';
import { resumenDemo, runDemoMotor } from './demo-motor.ts';
import { prepareDemoForDispatch, type DemoPreparation } from './demo-preparar.ts';
import { motorDbFromJob } from './motor-db.ts';
import { canceledCount, runDispatch, type DispatchReport } from './outbound.dispatch.ts';
import { runReplies, type RepliesReport } from './outbound.replies.ts';
import { cuenta, fechaHora } from './salida.ts';

type Pasada = 'dispatch' | 'replies';

interface Opciones {
  pasada: Pasada;
  canalFalso: boolean;
  /** Postgres embebido con el seed, canal falso: no toca ninguna base compartida. */
  demo: boolean;
  workspaceId: string | undefined;
  /** En vez de una pasada: dejar la demo lista (--preparar-demo) o encender su envío (--encender). */
  accion: 'pasada' | 'preparar-demo' | 'encender';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USO =
  'Uso: correr-motor.ts dispatch|replies [--canal-falso] [--workspace <uuid>] [--demo] [--preparar-demo | --encender] (las dos últimas, con --workspace de la demo)';

/** Lee los argumentos. Lanza ConfigError con el uso si algo no cuadra. */
export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Opciones {
  // pnpm pasa el «--» que separa sus argumentos de los del comando.
  const [pasada, ...resto] = argv.filter((a) => a !== '--');
  if (pasada !== 'dispatch' && pasada !== 'replies') {
    throw new ConfigError(USO);
  }
  let workspaceId: string | undefined;
  let canalFalso = env['OUTREACH_CHANNELS'] === 'fake';
  let demo = false;
  const acciones: Array<Opciones['accion']> = [];
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a === '--canal-falso') canalFalso = true;
    else if (a === '--demo') demo = true;
    else if (a === '--preparar-demo') acciones.push('preparar-demo');
    else if (a === '--encender') acciones.push('encender');
    else if (a === '--workspace') {
      const v = resto[++i];
      if (!v || !UUID.test(v)) throw new ConfigError(`--workspace pide el uuid de un workspace. ${USO}`);
      workspaceId = v;
    } else throw new ConfigError(`Argumento desconocido: ${a}. ${USO}`);
  }
  if (demo && pasada !== 'dispatch') throw new ConfigError('--demo solo existe para dispatch.');
  if (acciones.length > 1) throw new ConfigError('--preparar-demo y --encender van en comandos separados, uno por paso.');
  const accion = acciones[0] ?? 'pasada';
  if (accion !== 'pasada') {
    if (pasada !== 'dispatch' || demo) throw new ConfigError(`--${accion} solo existe para dispatch, sin --demo.`);
    if (!workspaceId || !(DEMO_WORKSPACE_IDS as readonly string[]).includes(workspaceId)) {
      throw new ConfigError(`--${accion} solo toca el workspace de la demo: --workspace ${DEMO_WORKSPACE_IDS.join(' o ')}.`);
    }
  }
  return { pasada, canalFalso: canalFalso || demo, demo, workspaceId, accion };
}

export { isLocalDatabase } from './canales/index.ts';

/**
 * El canal falso marca como enviados mensajes que nadie recibió y avanza
 * las cadencias: la misma regla que el worker programado (fakeAllowed).
 * Contra una base compartida, solo sobre el workspace de la demo. Lanza
 * ConfigError si no.
 */
export function assertFakeAllowed(o: Pick<Opciones, 'canalFalso' | 'demo' | 'workspaceId'>, databaseUrl: string | null | undefined): void {
  if (!o.canalFalso || o.demo) return;
  if (!fakeAllowed({ databaseUrl, workspaceId: o.workspaceId })) throw new ConfigError(fakeRefusal({}));
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
    `Despacho: ${cuenta(r.claim.claimed, 'reclamado', 'reclamados')}, ${cuenta(r.sent.length, 'enviado', 'enviados')}, ` +
      `${r.retried.length} a reintento, ${cuenta(r.failed.length, 'fallido', 'fallidos')}.`,
    `  Reprogramados por tope: ${r.claim.rescheduled.length}. Fuera de la ventana: ${r.claim.outsideWindow.length}. ` +
      `Esperando cuenta: ${r.claim.waitingAccount.length + r.waiting.length}. Retenidos: ${r.held.length}. Pospuestos: ${r.postponed.length}. ` +
      `Movidos por el ritmo (marca o cuenta): ${r.claim.paced.length}.`,
    `  Cancelados: ${canceledCount(r)} (${r.claim.canceledEmailInvalid} por correo rebotado, ${r.claim.canceledCompanyCap} por el tope de la marca). ` +
      `Sin dirección: ${r.claim.skippedNoAddress}. Dirección mal escrita: ${r.claim.skippedInvalidAddress}. ` +
      `Zombis: ${r.zombies.failed} a fallido, ${r.zombies.released} de vuelta a la cola. Sin intentar, de vuelta: ${r.released.length}.`,
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
    `Respuestas: ${cuenta(r.threads, 'hilo leído', 'hilos leídos')} en ${cuenta(r.pages, 'página', 'páginas')}, ` +
      `${cuenta(r.inbound, 'mensaje nuevo', 'mensajes nuevos')}, ${cuenta(r.optOuts, 'baja', 'bajas')}, ` +
      `${cuenta(r.automatic, 'automática', 'automáticas')}, ${cuenta(r.canceled, 'toque cancelado', 'toques cancelados')}.`,
  ];
  if (r.threadsRecovered) {
    lineas.push(`  ${cuenta(r.threadsRecovered, 'hilo encontrado', 'hilos encontrados')} de envíos confirmados a mano; ` +
      `${cuenta(r.released, 'respuesta vuelve', 'respuestas vuelven')} a la cola.`);
  }
  for (const u of r.unreadable) lineas.push(`  · ${u.channel} ${u.threadRef} sin leer: ${u.error}`);
  return `${lineas.join('\n')}\n`;
}

export function resumenPreparacion(p: DemoPreparation): string {
  const lineas = [
    'Demo lista para el despachador, con el envío apagado:',
    `  · el mensaje ${p.touchId} vence ya: ${fechaHora(p.dueAt, p.timeZone)};`,
    `  · ${cuenta(p.anchored, 'mensaje anterior', 'mensajes anteriores')} a esa marca, corridos para cumplir los días entre mensajes;`,
    `  · ${cuenta(p.reconnected, 'cuenta reconectada', 'cuentas reconectadas')} y la dirección postal del pie guardada.`,
  ];
  if (!p.insideWindow) {
    lineas.push(
      `  Ojo: ahora, ${fechaHora(new Date(), p.timeZone)}, está fuera del horario de envío (${p.window.start}–${p.window.end}, de lunes a viernes). ` +
        'El despachador no envía fuera de él: corre los pasos siguientes dentro del horario.',
    );
  }
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
    const motor = motorDbFromJob(db);
    const now = () => new Date();
    const ws = opciones.workspaceId!;
    if (opciones.accion === 'preparar-demo') {
      process.stdout.write(resumenPreparacion(await motor.transaction((tx) => prepareDemoForDispatch(tx, ws, now()))));
      return;
    }
    if (opciones.accion === 'encender') {
      const plan = await motor.transaction((tx) => enableOutreach(tx, { workspaceId: ws, now: now() }));
      process.stdout.write(
        `Envío encendido en ${ws}. ${cuenta(plan.scheduled + plan.held, 'mensaje cancelado al apagar vuelve', 'mensajes cancelados al apagar vuelven')} a la cola.\n`,
      );
      return;
    }
    const channels = buildChannels({
      env: process.env, secrets: secretStore(config, db, opciones.canalFalso), mode: opciones.canalFalso ? 'fake' : 'real',
      // Como el job: cada llamada a Gmail o a Unipile deja su fila en api_call_log.
      callLog: new PostgresOutreachCallLog(db),
    });
    if (channels.mode === 'fake') process.stdout.write('Canal falso: nada sale de la máquina.\n');
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
