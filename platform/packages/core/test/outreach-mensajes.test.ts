/**
 * VEN-10 r4 · los textos del motor (@mc/core/outreach/messages): held_reason
 * es un código que se traduce por idioma, y una nota de LinkedIn se mide
 * sin partir un emoji.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHoldReason, HOLD_CODES, HOLD_REASON_TEXTS, holdReasonText, inviteNoteOverflow, LINKEDIN_INVITE_NOTE_MAX, noticeLang,
  OUTREACH_URLS, parseHoldReason,
} from '../src/outreach/messages.ts';

test('held_reason: código y dato se escriben y se leen igual', () => {
  assert.equal(formatHoldReason({ code: 'no_postal_address' }), 'no_postal_address');
  assert.equal(formatHoldReason({ code: 'unconfirmed_attempt', detail: 3 }), 'unconfirmed_attempt:3');
  assert.deepEqual(parseHoldReason('placeholders:{{x}} [y]'), { code: 'placeholders', detail: '{{x}} [y]' });
  assert.deepEqual(parseHoldReason('reply_without_thread'), { code: 'reply_without_thread' });
  assert.equal(parseHoldReason('revisar el tono'), null, 'lo que escribió una persona no es un código');
  assert.equal(parseHoldReason(null), null);
});

test('cada código tiene su frase en español y en inglés, sin nombres de columnas', () => {
  for (const lang of ['es', 'en'] as const) {
    for (const code of HOLD_CODES) {
      const texto = HOLD_REASON_TEXTS[lang][code]('7');
      assert.ok(texto.length > 10, `${lang} ${code}`);
      assert.doesNotMatch(texto, /outbound_|postal_address|held_reason|_/, `${lang} ${code}: «${texto}»`);
    }
  }
  assert.match(holdReasonText('es', 'unconfirmed_attempt:2'), /intento 2/);
  assert.match(holdReasonText('en', 'placeholders:TBD'), /placeholders \(TBD\)/);
  assert.equal(holdReasonText('en', 'revisar el tono'), 'revisar el tono', 'lo manual se muestra tal cual');
});

test('la nota de LinkedIn se mide en caracteres, no en unidades de UTF-16', () => {
  assert.equal(inviteNoteOverflow('á'.repeat(LINKEDIN_INVITE_NOTE_MAX)), null);
  assert.equal(inviteNoteOverflow(`  ${'🙂'.repeat(LINKEDIN_INVITE_NOTE_MAX)}  `), null, 'un emoji cuenta uno');
  assert.equal(inviteNoteOverflow('a'.repeat(320)), 320);
});

test('el idioma y los destinos de los avisos', () => {
  assert.equal(noticeLang('en-US'), 'en');
  assert.equal(noticeLang('es-CO'), 'es');
  assert.equal(noticeLang(null), 'es');
  assert.equal(OUTREACH_URLS.channels, '/ventas/canales');
  assert.equal(OUTREACH_URLS.company('abc'), '/ventas/empresas/abc');
});
