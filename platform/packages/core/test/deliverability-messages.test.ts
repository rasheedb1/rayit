import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOOTER_TEXTS, OUTREACH_FALLBACK_LANGUAGE, OUTREACH_LANGUAGES, footerTextsFor, outreachLanguage,
} from '../src/outreach/deliverability-messages.ts';
import * as indice from '../src/outreach/deliverability.ts';
import { buildEmailFooter } from '../src/outreach/footer.ts';

test('el idioma sale del idioma base del locale, con Intl.Locale', () => {
  assert.equal(outreachLanguage('es-CO'), 'es');
  assert.equal(outreachLanguage('en-US'), 'en');
  assert.equal(outreachLanguage('EN-gb'), 'en');
  assert.equal(outreachLanguage('en_GB'), 'en', 'el guion bajo de un locale de POSIX también');
  assert.equal(outreachLanguage('en'), 'en');
  // «eng» o «enx» no son inglés: la regla vieja (/^en\b/) ya lo sabía; Intl también.
  assert.equal(outreachLanguage('enx'), OUTREACH_FALLBACK_LANGUAGE);
});

test('lo que el outreach no habla, o no es un locale, cae al respaldo explícito', () => {
  assert.equal(OUTREACH_FALLBACK_LANGUAGE, 'es');
  assert.equal(outreachLanguage('pt-BR'), 'es');
  assert.equal(outreachLanguage('fr'), 'es');
  assert.equal(outreachLanguage(''), 'es');
  assert.equal(outreachLanguage(null), 'es');
  assert.equal(outreachLanguage(undefined), 'es');
  assert.equal(outreachLanguage('no es un locale!!'), 'es');
});

test('cada idioma del outreach tiene su pie, sin plantillas rotas', () => {
  for (const idioma of OUTREACH_LANGUAGES) {
    const t = FOOTER_TEXTS[idioma];
    assert.ok(t.unsubscribeText.includes('{url}'), `${idioma}: la frase de texto plano lleva el enlace`);
    assert.ok(!t.unsubscribeHtmlLead.includes('{'), `${idioma}: el HTML no lleva marcadores`);
    assert.ok(t.unsubscribeLinkLabel.trim().length > 0);
    assert.equal(footerTextsFor(idioma), t);
  }
  assert.equal(footerTextsFor('en-US').unsubscribeLinkLabel, 'unsubscribe here');
  assert.equal(footerTextsFor('pt-BR'), FOOTER_TEXTS.es);
});

test('sin textos, el pie sale en el idioma de respaldo', () => {
  const r = buildEmailFooter({ postalAddress: 'Calle 1', unsubscribeUrl: 'https://a.test/baja/t' });
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.footer.text.includes(FOOTER_TEXTS[OUTREACH_FALLBACK_LANGUAGE].unsubscribeText.replace('{url}', 'https://a.test/baja/t')));
});

test('deliverability.ts sigue siendo el índice: lo de cada módulo se importa desde ahí', () => {
  for (const nombre of [
    'createOptoutToken', 'optoutUrl', 'listUnsubscribeHeaders', 'buildEmailFooter', 'footerTextsFor',
    'outreachLanguage', 'warmupDailyLimit', 'detectBounce', 'evaluateOutreachAlerts', 'channelAccountLabel',
  ]) {
    assert.equal(typeof (indice as Record<string, unknown>)[nombre], 'function', nombre);
  }
});
