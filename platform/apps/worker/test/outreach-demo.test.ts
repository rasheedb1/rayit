/**
 * VEN-10 · los comandos job:dispatch y job:replies, y la demo del motor
 * contra el seed del repositorio en Postgres embebido. Sin red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/runner/config.ts';
import { assertFakeAllowed, isLocalDatabase, parseArgs } from '../src/jobs/ventas/correr-motor.ts';
import { resumenDemo, runDemoMotor } from '../src/jobs/ventas/demo-motor.ts';

test('job:dispatch y job:replies leen sus argumentos y rechazan lo que no conocen', () => {
  assert.deepEqual(parseArgs(['dispatch'], {}), { pasada: 'dispatch', canalFalso: false, demo: false, workspaceId: undefined });
  // pnpm deja pasar el «--» que separa sus argumentos.
  assert.deepEqual(parseArgs(['dispatch', '--', '--canal-falso'], {}).canalFalso, true);
  assert.equal(parseArgs(['replies'], { OUTREACH_CHANNELS: 'fake' }).canalFalso, true);
  const ws = '00000002-0000-4000-8000-000000000001';
  assert.equal(parseArgs(['replies', '--workspace', ws], {}).workspaceId, ws);
  // La demo siempre va por el canal falso.
  assert.deepEqual(parseArgs(['dispatch', '--demo'], {}), { pasada: 'dispatch', canalFalso: true, demo: true, workspaceId: undefined });

  assert.throws(() => parseArgs([], {}), ConfigError);
  assert.throws(() => parseArgs(['enviar'], {}), ConfigError);
  assert.throws(() => parseArgs(['dispatch', '--workspace', 'laura'], {}), ConfigError);
  assert.throws(() => parseArgs(['dispatch', '--rapido'], {}), ConfigError);
  assert.throws(() => parseArgs(['replies', '--demo'], {}), ConfigError);
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

test('demo con el seed: apagada no envía nada; encendida, la cadencia de tres correos sale, una respuesta la corta y la otra sigue', async () => {
  const r = await runDemoMotor();

  // Mismo reloj, el toque ya vencido: lo único distinto es el interruptor.
  assert.equal(r.off.claim.claimed, 0);
  assert.equal(r.off.sent.length, 0);

  // El mensaje de LinkedIn del seed sale, y queda en outbound_touch con su id y su hilo.
  assert.equal(r.on.claim.claimed, 1);
  assert.deepEqual(r.on.failed, []);
  assert.equal(r.sentTouches.length, 1);
  const [touch] = r.sentTouches;
  assert.equal(touch!.status, 'sent');
  assert.ok(touch!.sent_at, 'el envío deja sent_at');
  assert.match(touch!.provider_message_id ?? '', /^fake-linkedin-/);
  assert.match(touch!.thread_ref ?? '', /^fake-thread-linkedin-/);

  // La cadencia: dos correos con su pie y su baja de un clic; una marca responde y se corta; la otra recibe el día 2 en el hilo.
  const c = r.cadence;
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
  assert.match(texto, /apagada\): 0 reclamado\(s\), 0 enviado\(s\)/);
  assert.match(texto, /List-Unsubscribe: <https:\/\/oncue\.test\/baja\/\S+\/un-clic>/);
  assert.match(texto, /LinkedIn a \S+: mensaje de LinkedIn/);
  assert.doesNotMatch(texto, /sin asunto/);
});
