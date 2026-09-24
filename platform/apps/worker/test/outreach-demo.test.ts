/**
 * VEN-10 · los comandos job:dispatch y job:replies, y la demo del motor
 * contra el seed del repositorio en Postgres embebido. Sin red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/runner/config.ts';
import { parseArgs } from '../src/jobs/ventas/correr-motor.ts';
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

test('demo con el seed: apagada no envía nada; encendida, el canal falso deja el envío en outbound_touch', async () => {
  const r = await runDemoMotor();

  // Mismo reloj, el toque ya vencido: lo único distinto es el interruptor.
  assert.equal(r.off.claim.claimed, 0);
  assert.equal(r.off.sent.length, 0);

  assert.equal(r.on.claim.claimed, 1);
  assert.deepEqual(r.on.failed, []);
  assert.equal(r.on.sent.length, 1);
  assert.equal(r.sentTouches.length, 1);
  const [touch] = r.sentTouches;
  assert.equal(touch!.status, 'sent');
  assert.ok(touch!.sent_at, 'el envío deja sent_at');
  assert.match(touch!.provider_message_id ?? '', /^fake-linkedin-/);
  assert.match(touch!.thread_ref ?? '', /^fake-thread-linkedin-/);
  assert.equal(r.delivered.length, 1);
  assert.equal(r.delivered[0]!.touchId, touch!.id);

  assert.match(resumenDemo(r), /apagada\): 0 reclamado\(s\), 0 enviado\(s\)/);
});
