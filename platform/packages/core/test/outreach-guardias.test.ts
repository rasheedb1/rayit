/**
 * VEN-10 · las guardias del punto de envío: placeholders, el detector de
 * baja (catorce expresiones) y el renderizador de plantillas fijas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPlaceholders, findPlaceholders, hasPlaceholders, PlaceholderError } from '../src/outreach/placeholder-guard.ts';
import { detectOptOut, OPT_OUT_RULES, optoutUrl, stripQuoted } from '../src/outreach/optout.ts';
import { firstNameOf, renderTemplate } from '../src/outreach/template.ts';

test('la guardia bloquea los siete tipos de hueco', () => {
  const casos: Array<[string, string]> = [
    ['Hola, {{first_name}}', 'double_brace'],
    ['Hola, {nombre}', 'single_brace'],
    ['Hola, [NOMBRE]', 'bracket'],
    ['Hola, <nombre de la marca>', 'angle'],
    ['Hola, ${first_name}', 'template_literal'],
    ['Precio: TBD', 'tbd'],
    ['TODO: poner la cifra', 'todo'],
  ];
  for (const [texto, tipo] of casos) {
    const hits = findPlaceholders(texto);
    assert.equal(hits.length, 1, texto);
    assert.equal(hits[0]!.kind, tipo, texto);
  }
});

test('la guardia deja pasar texto normal, en español también', () => {
  for (const texto of [
    'Hola, Sofía: todo bien por aquí. ¿Te interesa ver el video?',
    'Todos los martes publico recetas.',
    'Mi audiencia: 64 % mujeres de 25 a 34 años.',
    'Te escribo por {} y [] vacíos, que no son huecos.',
  ]) {
    assert.deepEqual(findPlaceholders(texto), [], texto);
  }
  assert.equal(hasPlaceholders(null, undefined, ''), false);
  assert.doesNotThrow(() => assertNoPlaceholders('Asunto', 'Cuerpo'));
  assert.throws(() => assertNoPlaceholders('Hola {{x}}', 'Cuerpo TBD'), (e: unknown) => e instanceof PlaceholderError && e.hits.length === 2);
});

test('${x} cuenta una vez, no también como {x}', () => {
  assert.equal(findPlaceholders('${a} y {b}').length, 2);
});

test('el detector reconoce las catorce expresiones', () => {
  assert.equal(OPT_OUT_RULES.length, 14);
  const frases: Record<string, string> = {
    es_dar_de_baja: 'Por favor, dénme de baja.',
    es_no_escribir: 'No me vuelvan a escribir, gracias.',
    es_quitar_de_lista: 'Quítenme de su lista.',
    es_no_recibir: 'No quiero recibir más correos.',
    es_dejar_de_escribir: 'Dejen de escribirme.',
    es_cancelar_suscripcion: 'Quiero cancelar mi suscripción.',
    es_no_contactar: 'Favor no contactar.',
    en_unsubscribe: 'Unsubscribe',
    en_remove_me: 'Please remove me.',
    en_stop_contacting: 'Stop emailing me.',
    en_do_not_contact: "Don't contact us again.",
    en_opt_out: 'I want to opt-out.',
    en_take_me_off: 'Take me off your list.',
    en_no_more_emails: 'No more emails please.',
  };
  for (const rule of OPT_OUT_RULES) {
    const r = detectOptOut(frases[rule.id]);
    assert.equal(r.optOut, true, `${rule.id}: «${frases[rule.id]}»`);
    assert.equal(r.ruleId, rule.id, frases[rule.id]);
  }
});

test('el detector no confunde un «ahora no», un interés ni nuestro pie citado', () => {
  for (const texto of [
    'Hola, Laura. Sí, justo estamos armando la temporada. ¿Te sirve una llamada el jueves?',
    'Gracias. Este trimestre no tenemos presupuesto; escríbeme después de enero.',
    'No estoy interesada por ahora.',
    'Me encanta, ¿me mandas tu media kit?',
    'Suena bien.\n\nEl mar, 22 sept 2026 a las 10:00, Laura <laura@x.test> escribió:\n> Para darte de baja: https://oncue.test/baja/abc',
    'Sounds good!\n> To unsubscribe click here',
  ]) {
    assert.equal(detectOptOut(texto).optOut, false, texto);
  }
  assert.equal(stripQuoted('hola\n> citado\nadiós'), 'hola\nadiós');
});

test('el enlace de baja: ruta pública y token validado', () => {
  assert.equal(optoutUrl('https://on-cue-web.vercel.app/', 'abcdefghijklmnop1234'), 'https://on-cue-web.vercel.app/baja/abcdefghijklmnop1234');
  assert.throws(() => optoutUrl('https://x.test', 'corto'), TypeError);
  assert.throws(() => optoutUrl('ftp://x.test', 'abcdefghijklmnop1234'), TypeError);
});

test('el renderizador sustituye lo conocido y deja a la vista lo que falta', () => {
  assert.equal(
    renderTemplate('Hola, {{ first_name }}: te escribo por {{company}}.', { first_name: 'Sofía', company: 'Vitalé' }),
    'Hola, Sofía: te escribo por Vitalé.',
  );
  assert.equal(renderTemplate('Hola, {{first_name}} {{apodo}}', { first_name: '  ' }), 'Hola, {{first_name}} {{apodo}}');
  assert.equal(renderTemplate(null, {}), null);
  assert.equal(firstNameOf('  Sofía Cárdenas '), 'Sofía');
  assert.equal(firstNameOf(null), null);
});
