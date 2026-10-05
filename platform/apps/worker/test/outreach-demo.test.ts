/**
 * VEN-10 · los comandos job:dispatch y job:replies, y la demo del motor
 * contra el seed del repositorio en Postgres embebido. Sin red.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySecretStore } from '@mc/connectors';
import { emptyClaimReport, enableOutreach } from '@mc/db/queries/outreach';
import { buildChannels, channelModeFrom, databaseUrlFrom, fakeAllowed, jobScope } from '../src/jobs/ventas/canales/index.ts';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import {
  assertFakeAllowed, isLocalDatabase, parseArgs, pideAyuda, resumenDespacho, resumenPreparacion, USO,
} from '../src/jobs/ventas/correr-motor.ts';
import { DEMO_WORKSPACE_ID } from '../src/jobs/ventas/demo-ids.ts';
import { resumenDemo, runDemoMotor } from '../src/jobs/ventas/demo-motor.ts';
import { nextDemoTouch, prepareDemoForDispatch } from '../src/jobs/ventas/demo-preparar.ts';
import { motorDbFromClient } from '../src/jobs/ventas/motor-db.ts';
import { canceledCount, runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { ConfigError } from '../src/runner/config.ts';
import { SETUP_TIMEOUT } from './helpers/harness.ts';
import { aperturaReciente } from './helpers/ventana.ts';

/**
 * Las dos pruebas de la demo abren una base con TODOS los seeds. Migrar y
 * sembrar se hace una vez, aquí, con el tiempo del arranque
 * (SETUP_TIMEOUT); cada prueba abre su copia desde esa foto en décimas
 * de segundo. Antes, cada una migraba y sembraba dentro de su propio tope
 * de 120 s y, con la máquina cargada, la primera corrida de `pnpm
 * verificar` se pasó (123 s; sola tarda 3 s).
 */
before(async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  await (await createEmbeddedDb({ snapshot: true })).close();
}, SETUP_TIMEOUT);

/** El tope de las pruebas de la demo: abrir la foto y correr el motor, con margen para una máquina cargada. */
const DEMO_TIMEOUT = { timeout: 240_000 } as const;

test('job:dispatch y job:replies leen sus argumentos y rechazan lo que no conocen', () => {
  assert.deepEqual(parseArgs(['dispatch'], {}), { pasada: 'dispatch', canalFalso: false, demo: false, workspaceId: undefined, accion: 'pasada' });
  // pnpm deja pasar el «--» que separa sus argumentos.
  assert.deepEqual(parseArgs(['dispatch', '--', '--canal-falso'], {}).canalFalso, true);
  assert.equal(parseArgs(['replies'], { OUTREACH_CHANNELS: 'fake' }).canalFalso, true);
  const ws = '00000002-0000-4000-8000-000000000001';
  assert.equal(parseArgs(['replies', '--workspace', ws], {}).workspaceId, ws);
  // La demo siempre va por el canal falso.
  assert.deepEqual(parseArgs(['dispatch', '--demo'], {}), { pasada: 'dispatch', canalFalso: true, demo: true, workspaceId: undefined, accion: 'pasada' });
  // Preparar y encender la demo: un comando por paso, solo con el workspace de la demo.
  assert.equal(parseArgs(['dispatch', '--', '--preparar-demo', '--workspace', ws], {}).accion, 'preparar-demo');
  assert.equal(parseArgs(['dispatch', '--encender', '--workspace', ws], {}).accion, 'encender');
  assert.throws(() => parseArgs(['dispatch', '--encender', '--workspace', '0000000b-0000-4000-8000-000000000001'], {}), /solo toca el workspace de la demo/);
  assert.throws(() => parseArgs(['dispatch', '--preparar-demo'], {}), ConfigError);
  assert.throws(() => parseArgs(['dispatch', '--preparar-demo', '--encender', '--workspace', ws], {}), /uno por paso/);
  assert.throws(() => parseArgs(['replies', '--encender', '--workspace', ws], {}), ConfigError);

  assert.throws(() => parseArgs([], {}), ConfigError);
  assert.throws(() => parseArgs(['enviar'], {}), ConfigError);
  assert.throws(() => parseArgs(['dispatch', '--workspace', 'laura'], {}), ConfigError);
  assert.throws(() => parseArgs(['dispatch', '--rapido'], {}), ConfigError);
  assert.throws(() => parseArgs(['replies', '--demo'], {}), /va dentro de job:dispatch -- --demo/);
});

test('--ayuda y --help enseñan el uso con los comandos de pnpm, no el nombre del archivo', () => {
  for (const argv of [['dispatch', '--', '--ayuda'], ['replies', '--help'], ['--ayuda'], ['-h']]) assert.equal(pideAyuda(argv), true, argv.join(' '));
  assert.equal(pideAyuda(['dispatch', '--canal-falso']), false);
  assert.match(USO, /pnpm --filter @mc\/worker run job:dispatch --/);
  assert.match(USO, /pnpm --filter @mc\/worker run job:replies --/);
  assert.doesNotMatch(USO, /correr-motor\.ts/);
  // Un argumento desconocido sigue siendo un error, con el uso.
  assert.throws(() => parseArgs(['dispatch', '--rapido'], {}), (e: Error) => e instanceof ConfigError && e.message.includes('job:dispatch'));
});

test('job:dispatch cuenta los cancelados como la metadata del job, y un argumento desconocido enseña el uso', () => {
  const r = {
    zombies: { failed: 0, canceled: 0, released: 0 },
    claim: { ...emptyClaimReport(), claimed: 0, canceledOptedOut: 1, canceledEmailInvalid: 2, canceledFinished: 3, skippedNoAddress: 4, canceledCompanyCap: 5, canceledBriefExcluded: 6 },
    sent: [], confirmed: [], retried: [], failed: [], waiting: [], canceled: [{ touchId: 'x', reason: 'opted_out' }], postponed: [], held: [],
    released: [], warnings: [], errors: [], notConfigured: [], budget: 0,
  };
  assert.equal(canceledCount(r), 18);
  const texto = resumenDespacho(r);
  assert.match(texto, /Cancelados: 18 \(2 por correo rebotado, 5 por el tope de la marca, 6 porque el brief no acepta la marca\)\. Sin dirección: 4\./);
  assert.match(texto, /^Despacho: 0 reclamados, 0 enviados, 0 a reintento, 0 fallidos\./, 'con su plural, sin «(s)»');
  assert.match(resumenDespacho({ ...r, claim: { ...r.claim, claimed: 1 }, sent: ['t'] }), /^Despacho: 1 reclamado, 1 enviado,/);
  assert.throws(() => parseArgs(['dispatch', '--foo'], {}), /Argumento desconocido: --foo\. Uso:\n  pnpm --filter @mc\/worker run job:dispatch/);
});

test('el canal falso contra una base compartida solo corre sobre el workspace de la demo', () => {
  const supabase = 'postgresql://mc_migrator.x:clave@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
  const demo = '00000002-0000-4000-8000-000000000001';
  const falso = (workspaceId?: string) => ({ canalFalso: true, demo: false, workspaceId });
  assert.throws(() => assertFakeAllowed(falso(), supabase), ConfigError, 'sin --workspace, no');
  assert.throws(() => assertFakeAllowed(falso('0000000b-0000-4000-8000-000000000001'), supabase), ConfigError, 'otro workspace, no');
  assert.doesNotThrow(() => assertFakeAllowed(falso(demo), supabase));
  assert.doesNotThrow(() => assertFakeAllowed(falso(), 'postgresql://postgres@localhost:5432/mc'));
  assert.doesNotThrow(() => assertFakeAllowed({ canalFalso: false, demo: false, workspaceId: undefined }, supabase), 'los canales reales, siempre');
  assert.equal(isLocalDatabase('postgresql://u@127.0.0.1/x'), true);
  assert.equal(isLocalDatabase(supabase), false);
  assert.equal(isLocalDatabase(null), false);
});

test('el worker programado sigue la misma regla: con Supabase y NODE_ENV=development, OUTREACH_CHANNELS=fake no arranca', () => {
  const supabase = 'postgresql://mc_migrator.x:clave@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
  const env = { OUTREACH_CHANNELS: 'fake', NODE_ENV: 'development', DATABASE_URL_DIRECT: supabase };
  // El arranque del worker (src/index.ts) y cada job (jobScope) preguntan lo mismo.
  assert.throws(() => channelModeFrom(env, { databaseUrl: supabase }), ConfigError);
  assert.throws(() => channelModeFrom(env, jobScope({ env, db: { kind: 'postgres' } })), ConfigError);
  assert.throws(() => buildChannels({ env, scope: jobScope({ env, db: { kind: 'postgres' } }), secrets: new InMemorySecretStore() }), ConfigError);
  assert.equal(databaseUrlFrom(env), supabase);
  // Con el embebido (worker --pglite o --demo) o una base local, sí.
  assert.equal(channelModeFrom(env, jobScope({ env, db: { kind: 'pglite' } })), 'fake');
  assert.equal(channelModeFrom({ ...env, DATABASE_URL_DIRECT: 'postgresql://postgres@localhost:5432/mc' }, { databaseUrl: 'postgresql://postgres@localhost:5432/mc' }), 'fake');
  // Solo el workspace de la demo, contra Supabase: la corrida a mano.
  assert.equal(fakeAllowed({ databaseUrl: supabase, workspaceId: '00000002-0000-4000-8000-000000000001' }), true);
  assert.equal(fakeAllowed({ databaseUrl: supabase }), false);
  // Sin pedir el canal falso, siempre el real.
  assert.equal(channelModeFrom({ NODE_ENV: 'production', DATABASE_URL_DIRECT: supabase }, { databaseUrl: supabase }), 'real');
});

test('demo con el seed: apagada no envía nada; encendida, la cadencia de tres correos sale, una respuesta la corta y la otra sigue', DEMO_TIMEOUT, async () => {
  const r = await runDemoMotor({ snapshot: true });

  // Mismo reloj, el toque ya vencido: lo único distinto es el interruptor.
  assert.equal(r.off.claim.claimed, 0);
  assert.equal(r.off.sent.length, 0);

  // Encendida, el mensaje de LinkedIn del seed espera: la política del
  // seed pide tres días entre mensajes a Vitalé, y el seed le escribió ayer.
  assert.equal(r.on.claim.claimed, 0);
  assert.deepEqual(r.on.claim.paced.map((x) => x.reason), ['company_gap']);
  assert.ok(r.laterClock.getTime() - r.clock.getTime() > 0);
  // Cuando se cumplen, sale, y queda en outbound_touch con su id y su hilo.
  assert.equal(r.later.claim.claimed, 1);
  assert.deepEqual(r.later.failed, []);
  assert.equal(r.sentTouches.length, 1);
  const [touch] = r.sentTouches;
  assert.equal(touch!.status, 'sent');
  assert.ok(touch!.sent_at, 'el envío deja sent_at');
  assert.match(touch!.provider_message_id ?? '', /^fake-linkedin-/);
  assert.match(touch!.thread_ref ?? '', /^fake-thread-linkedin-/);

  // La cadencia: dos correos con su pie y su baja de un clic; una marca responde y se corta; la otra recibe el día 2 en el hilo.
  const c = r.cadence;
  // La revisión humana del seed: los seis mensajes nacen retenidos y la creadora los aprueba.
  assert.equal(c.approved, 6);
  assert.equal(c.first.sent.length, 2);
  const correos = r.delivered.filter((d) => d.channel === 'email');
  for (const m of correos) {
    assert.match(m.body, /https:\/\/oncue\.test\/baja\/[A-Za-z0-9_-]{43}\n/, 'el pie lleva la página de baja');
    assert.match(m.unsubscribeUrl ?? '', /\/un-clic$/, 'y la cabecera, la baja de un clic');
  }
  assert.equal(c.replies.inbound, 1);
  assert.equal(c.replies.canceled, 2);
  assert.equal(c.next.sent.length, 1);
  assert.deepEqual(c.statuses.map((s) => s.statuses), [['sent', 'canceled', 'canceled'], ['sent', 'sent', 'scheduled']]);
  const segundo = correos.at(-1)!;
  assert.match(segundo.subject ?? '', /^Re: /);
  assert.equal(segundo.threadRef, correos.find((m) => m.recipient === segundo.recipient)!.threadRef, 'en el mismo hilo');

  const texto = resumenDemo(r);
  assert.match(texto, /apagada\): 0 reclamados, 0 enviados/);
  assert.match(texto, /1 esperando la separación con la marca/);
  assert.match(texto, /la creadora aprueba 6 mensajes/);
  assert.doesNotMatch(texto, /\(s\)|\d{4}-\d{2}-\d{2}T/, 'ni «(s)» ni horas en ISO UTC');
  assert.match(texto, /Reloj: \p{L}+ \d+ de \p{L}+ a las \d\d:\d\d, hora estándar de Colombia\./u, 'la hora en la zona del workspace, sin paréntesis');
  assert.match(texto, /6\. Tres días hábiles después, el \p{L}+ \d+ de \p{L}+ a las \d\d:\d\d, hora estándar de Colombia: /u);
  assert.doesNotMatch(texto, /\([^()]*\(/, 'sin paréntesis anidados');
  assert.match(texto, /: enviado → cancelado → cancelado$/m, 'los estados en español');
  assert.doesNotMatch(texto.replace(/^ {3}· outbound_touch .*$/gm, ''), /\b(sent|canceled|scheduled)\b/, 'ningún estado de la base en inglés fuera de la fila de la base');
  assert.match(texto, /outbound_touch \S+: status=sent, provider_message_id=fake-linkedin-\d+/);
  assert.match(texto, /List-Unsubscribe: <https:\/\/oncue\.test\/baja\/\S+\/un-clic>/);
  assert.match(texto, /LinkedIn a \S+: mensaje de LinkedIn/);
  assert.doesNotMatch(texto, /sin asunto/);
});

test('--preparar-demo deja la demo lista con el reloj de verdad, sin SQL a mano: apagada no sale nada; con --encender sale el mensaje del seed', DEMO_TIMEOUT, async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  const db = await createEmbeddedDb({ snapshot: true });
  try {
    const motor = motorDbFromClient(db);
    // El reloj de quien integra, dentro del horario de envío (en la prueba, la última apertura si
    // ahora no lo es: la próxima, un fin de semana, caía en el futuro de la base; CIM-12).
    const siguiente = await motor.transaction((tx) => nextDemoTouch(tx, DEMO_WORKSPACE_ID));
    assert.ok(siguiente, 'el seed de outreach tiene un mensaje programado');
    const clock = aperturaReciente(siguiente.timeZone, siguiente.window);
    const prep = await motor.transaction((tx) => prepareDemoForDispatch(tx, DEMO_WORKSPACE_ID, clock));
    assert.equal(prep.insideWindow, true);
    assert.equal(prep.reconnected, 1, 'el LinkedIn de la demo');
    assert.ok(prep.anchored > 0, 'lo enviado a Vitalé queda lo bastante atrás');
    assert.match(resumenPreparacion(prep), /vence ya/);
    assert.doesNotMatch(resumenPreparacion(prep), /fuera del horario/);
    // Fuera del horario lo dice, con la ventana en horas y minutos (la base la da como «09:00:00»).
    const deNoche = resumenPreparacion({ ...prep, insideWindow: false, window: { start: '09:00:00', end: '17:00:00' } });
    assert.match(deNoche, /fuera del horario de envío \(09:00–17:00, de lunes a viernes\)/);
    assert.doesNotMatch(deNoche, /\([^()]*\(/, 'sin paréntesis anidados');

    const fake = fakeChannels();
    const pasada = () => runDispatch(motor, { senders: fake, appUrl: 'https://oncue.test', now: () => clock, workspaceId: DEMO_WORKSPACE_ID });
    const apagada = await pasada();
    assert.match(resumenDespacho(apagada), /^Despacho: 0 reclamados, 0 enviados/);

    const plan = await motor.transaction((tx) => enableOutreach(tx, { workspaceId: DEMO_WORKSPACE_ID, now: clock }));
    assert.equal(plan.scheduled + plan.held, 0, 'preparar no canceló nada: no hay nada que devolver');
    const encendida = await pasada();
    assert.ok(encendida.sent.includes(prep.touchId), resumenDespacho(encendida));
    const [fila] = (await db.asWorker((tx) =>
      tx.query<{ status: string; provider_message_id: string | null }>(`SELECT status, provider_message_id FROM outbound_touch WHERE id = $1`, [prep.touchId]),
    )).rows;
    assert.equal(fila!.status, 'sent');
    assert.match(fila!.provider_message_id ?? '', /^fake-linkedin-/);
  } finally {
    await db.close();
  }
});
