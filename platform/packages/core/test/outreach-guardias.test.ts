/**
 * VEN-10 · las guardias del punto de envío: placeholders, el detector de
 * baja (catorce expresiones) y el renderizador de plantillas fijas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPlaceholders, findPlaceholders, hasPlaceholders, PlaceholderError } from '../src/outreach/placeholder-guard.ts';
import { detectOptOut, OPT_OUT_RULES, stripQuoted, stripSignature } from '../src/outreach/optout.ts';
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

test('el detector reconoce las catorce expresiones, y la de portugués (r4)', () => {
  assert.equal(OPT_OUT_RULES.filter((r) => r.lang !== 'pt').length, 14);
  assert.equal(OPT_OUT_RULES.length, 15);
  const frases: Record<string, string> = {
    es_dar_de_baja: 'Por favor, dénme de baja.',
    es_no_escribir: 'No me vuelvan a escribir, gracias.',
    es_quitar_de_lista: 'Quítenme de su lista.',
    es_no_recibir: 'No quiero recibir más correos.',
    es_dejar_de_escribir: 'Dejen de escribirme.',
    es_cancelar_suscripcion: 'Quiero cancelar mi suscripción.',
    es_no_contactar: 'Favor no contactar.',
    en_unsubscribe: 'Unsubscribe',
    en_remove_me: 'Please remove me from your list.',
    en_stop_contacting: 'Stop emailing me.',
    en_do_not_contact: "Don't contact us again.",
    en_opt_out: 'I want to opt-out.',
    en_take_me_off: 'Take me off your list.',
    en_no_more_emails: 'No more emails please.',
    pt_nao_escrever: 'Por favor, não me escreva mais.',
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

test('el detector no toma por baja a una marca interesada (VEN-10 r2)', () => {
  // Los cinco casos de la revisión: pretérito, pregunta, firma corporativa y «remove me from the CC».
  for (const texto of [
    'no me enviaste el media kit, ¿me lo mandas?',
    'No nos mandaste la tarifa. Nos interesa mucho',
    '¿No me contactas el lunes?',
    'Perfecto, hablemos el jueves.\n\nSaludos,\nMarcela Ríos\nMarketing · Vitalé\nTo unsubscribe from our newsletter, click here.',
    'Sure, remove me from the CC and loop in Andrés.',
    // Y otros parecidos.
    'No me mandes el contrato todavía, lo reviso el lunes.',
    '¿Por qué no contactar a nuestra agencia? Ellos llevan la cuenta.',
    'No quiero recibir la muestra sin antes ver las tarifas.',
    "Don't email me the contract, send it by DocuSign.",
    'Can creators opt out of the exclusivity clause?',
    'No more emails needed, let us hop on a call.',
    'Please take me off the thread, Carla will follow up.',
    'Great!\n--\nAna · Brand Manager\nUnsubscribe\nPrivacy',
    'Thanks.\n\nBest regards,\nJohn\nIf you no longer wish to receive these emails, unsubscribe here.',
  ]) {
    assert.equal(detectOptOut(texto).optOut, false, texto);
  }
});

test('el detector sí ve la baja en sus formas reales, y en la primera línea lo que solo vale solo', () => {
  const casos: Array<[string, string]> = [
    ['No nos escriban más, por favor.', 'es_no_escribir'],
    ['Gracias, pero no me contactes.', 'es_no_escribir'],
    ['No me vuelvas a mandar nada.', 'es_no_escribir'],
    ['Buenas. Por favor dar de baja este correo.', 'es_dar_de_baja'],
    ['No queremos que nos sigan escribiendo.', 'es_no_recibir'],
    ['Unsubscribe me, please.', 'en_unsubscribe'],
    ['unsubscribe\n\nSent from my iPhone', 'en_unsubscribe'],
    ['Please remove us from your mailing list.', 'en_remove_me'],
    ['Please don’t contact me again.', 'en_do_not_contact'],
    ['Opt out', 'en_opt_out'],
    ['We’d like to opt out.', 'en_opt_out'],
  ];
  for (const [texto, regla] of casos) {
    const r = detectOptOut(texto);
    assert.equal(r.optOut, true, texto);
    assert.equal(r.ruleId, regla, texto);
  }
  // «Unsubscribe» suelto solo cuenta arriba: en la línea diez es otra cosa.
  const largo = ['Hola,', 'uno', 'dos', 'tres', 'cuatro', 'unsubscribe'].join('\n');
  assert.equal(detectOptOut(largo).optOut, false);
  assert.equal(stripSignature('Hola\n--\nFirma\nunsubscribe'), 'Hola');
  assert.equal(stripSignature('Hola\nSaludos, Marcela\nTo unsubscribe…'), 'Hola');
});

test('una respuesta de una línea que empieza por el saludo es el mensaje, no la firma (r3)', () => {
  for (const texto of [
    'Saludos. No nos escriban más.',
    'Saludos, por favor dejen de escribirnos',
    'Cordialmente les pido que me saquen de su lista',
  ]) {
    assert.notEqual(stripSignature(texto).trim(), '', texto);
    assert.equal(detectOptOut(texto).optOut, true, texto);
  }
  // Y la firma de verdad se sigue quitando: el saludo solo, o con un nombre, después del mensaje.
  assert.equal(stripSignature('Nos interesa, hablemos.\nSaludos,\nMarcela'), 'Nos interesa, hablemos.');
  assert.equal(stripSignature('Nos interesa.\nBest, John Smith\nUnsubscribe'), 'Nos interesa.');
  assert.equal(stripSignature('Nos interesa.\nSaludos, por favor sigan'), 'Nos interesa.\nSaludos, por favor sigan');
});

test('las formas pronominales de la baja en español (r3)', () => {
  const casos: Array<[string, string]> = [
    ['No vuelvan a escribirnos.', 'es_no_escribir'],
    ['Por favor no volver a contactarnos', 'es_no_escribir'],
    ['Les pido que me saquen de su lista.', 'es_quitar_de_lista'],
    ['NO NOS INTERESA, NO ESCRIBAN MAS', 'es_no_escribir'],
  ];
  for (const [texto, regla] of casos) {
    const r = detectOptOut(texto);
    assert.equal(r.optOut, true, texto);
    assert.equal(r.ruleId, regla, texto);
  }
  // Sin pronombre y sin «más», el subjuntivo sigue sin ser baja: tiene un objeto.
  for (const texto of ['No manden el contrato todavía.', '¿No vuelves a escribir el lunes?', 'No nos interesa por ahora.']) {
    assert.equal(detectOptOut(texto).optOut, false, texto);
  }
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

test('el detector ve las bajas más comunes que la ronda 3 dejaba pasar (r4)', () => {
  const casos: Array<[string, string]> = [
    ['Sáquenme de su lista', 'es_quitar_de_lista'],
    ['Sáquenme de su lista, por favor.', 'es_quitar_de_lista'],
    ['Por favor eliminen mi correo de su base de datos', 'es_quitar_de_lista'],
    ['Baja', 'es_dar_de_baja'],
    ['BAJA', 'es_dar_de_baja'],
    ['Dar de baja', 'es_dar_de_baja'],
    ['Dar de baja por favor', 'es_dar_de_baja'],
    ['Por favor, baja.', 'es_dar_de_baja'],
    ['No quiero más correos', 'es_no_recibir'],
    ['No queremos más mensajes, gracias.', 'es_no_recibir'],
    ['STOP', 'en_stop_contacting'],
    ['stop.', 'en_stop_contacting'],
    ['Please remove me.', 'en_remove_me'],
    ['Not interested, please remove me.', 'en_remove_me'],
    ['Remove me', 'en_remove_me'],
    ['Parar', 'pt_nao_escrever'],
    ['Me descadastre, por favor.', 'pt_nao_escrever'],
  ];
  for (const [texto, regla] of casos) {
    const r = detectOptOut(texto);
    assert.equal(r.optOut, true, texto);
    assert.equal(r.ruleId, regla, texto);
  }
});

test('las reglas nuevas no toman por baja lo que no lo es (r4)', () => {
  for (const texto of [
    'Stop by our office next week.',
    'Sure, please remove me from the CC and loop in Andrés.',
    'La baja de precios nos interesa: ¿hablamos?',
    'Estamos de baja por maternidad hasta marzo, escríbenos en abril.',
    'No quiero más correos sin la propuesta adjunta: ¿me la mandas?',
    'Saquemos la campaña de su lista de pendientes, ¿te parece?',
    '¿Cómo es el proceso de baja de un creador?',
  ]) {
    assert.equal(detectOptOut(texto).optOut, false, texto);
  }
});

test('el saludo de apertura y un «De:» sin cita no se comen la baja (r3, hallazgos 1 y 18)', () => {
  const casos: Array<[string, string]> = [
    ['Saludos, por favor denme de baja.', 'es_dar_de_baja'],
    ['Cordialmente, no me escriban más.', 'es_no_escribir'],
    ['Saludos.\nNo nos contacten más.', 'es_no_escribir'],
    ['Best, please remove me from your list', 'en_remove_me'],
    ['De: Sofía\nPor favor denme de baja', 'es_dar_de_baja'],
    ['Saludos, no me escriban más', 'es_no_escribir'],
    ['Gracias, por favor no nos contacten más', 'es_no_escribir'],
    // El saludo solo DESPUÉS de algo escrito, seguido de la petición y no de un nombre.
    ['Gracias.\nSaludos,\nNo nos contacten más.', 'es_no_escribir'],
  ];
  for (const [texto, regla] of casos) {
    const r = detectOptOut(texto);
    assert.equal(r.optOut, true, texto);
    assert.equal(r.ruleId, regla, texto);
  }
  // «De:» abre la cita solo con otra cabecera debajo (Outlook, Apple Mail).
  assert.equal(stripQuoted('De: Sofía\nPor favor denme de baja'), 'De: Sofía\nPor favor denme de baja');
  assert.equal(
    stripQuoted('Nos interesa.\n\nDe: Laura <l@x.co>\nEnviado: martes\nPara: Sofía\nAsunto: Idea\n\nPara darte de baja…'),
    'Nos interesa.\n',
  );
  assert.equal(stripQuoted('Ok\nFrom: Laura\nSent: Tuesday\nTo: Ana\n\nunsubscribe'), 'Ok');
  // La firma de verdad se sigue quitando: el saludo solo, seguido de un nombre o de nada.
  assert.equal(stripSignature('Nos interesa.\nSaludos,\nMaría de la Cruz\nTo unsubscribe…'), 'Nos interesa.');
  assert.equal(stripSignature('Nos interesa.\n\nSaludos,'), 'Nos interesa.\n');
  assert.equal(stripSignature('Gracias.\nSaludos,\nNo nos contacten más.'), 'Gracias.\nSaludos,\nNo nos contacten más.');
  assert.equal(detectOptOut('Nos interesa.\nSaludos,\nMarcela\nIf you no longer wish to receive these emails, unsubscribe').optOut, false);
});
