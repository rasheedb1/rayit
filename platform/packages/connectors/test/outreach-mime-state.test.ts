import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleId, buildMime, encodeHeaderWord, MimeError, toGmailRaw } from '../src/outreach/mime.ts';
import {
  CHANNEL_STATE_TYPICAL_CHARS, channelStateKey, GOOGLE_STATE_TTL_MS, newNonce, pendingAccountId, signChannelState, verifyChannelState, type ChannelState,
} from '../src/outreach/state.ts';
import { openWithAnyKey, sealValue } from '../src/crypto/sealed-cookie.ts';
import { UNIPILE_NAME_WARN_CHARS } from '../src/unipile.ts';

const boundary = (n: number) => `b${n}`;
const decodeWord = (w: string) => Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(w)![1]!, 'base64').toString('utf8');

test('encodeHeaderWord: ASCII tal cual; con acentos, palabras RFC 2047 de ≤ 75 que no parten un carácter', () => {
  assert.equal(encodeHeaderWord('Hola Marta'), 'Hola Marta');
  const subject = 'Una idea para Café Alma: campaña de otoño con recetas de cafetería en casa, año 2026 ñandú';
  const encoded = encodeHeaderWord(subject);
  const words = encoded.split('\r\n ');
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, `palabra de ${w.length}`);
  assert.equal(words.map(decodeWord).join(''), subject);
});

test('buildMime: texto plano en base64 UTF-8, remitente con acento, hilo con el Message-ID real', () => {
  const mime = buildMime({
    from: { address: 'laura@cocina-facil.test', name: 'Laura Gómez' }, to: { address: 'marta@cafealma.test', name: 'Marta' },
    subject: 'Re: Café', text: 'Hola Marta, ¿cómo vas?', inReplyTo: 'CAPrev@mail.gmail.com', references: ['<CAFirst@mail.gmail.com>', '<CAPrev@mail.gmail.com>'],
  }, { boundary });
  const [head, body] = mime.split('\r\n\r\n');
  assert.match(head!, /^From: =\?UTF-8\?B\?.+\?= <laura@cocina-facil\.test>$/m);
  assert.match(head!, /^To: "Marta" <marta@cafealma\.test>$/m);
  assert.match(head!, /^In-Reply-To: <CAPrev@mail\.gmail\.com>$/m);
  assert.match(head!, /^References: <CAFirst@mail\.gmail\.com> <CAPrev@mail\.gmail\.com>$/m);
  assert.match(head!, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.equal(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hola Marta, ¿cómo vas?');
  assert.ok(!/threadId|18c1f/.test(head!), 'el threadId de Gmail no entra en el MIME');
});

test('buildMime: el mailto de baja se valida como una dirección; un «>» o una «,» no meten otra entrada', () => {
  const base = { from: { address: 'yo@gmail.com' }, to: { address: 'marca@marca.test' }, subject: 'Hola', text: 'Hola', unsubscribeUrl: 'https://app.test/baja/abc' };
  for (const malo of ['x@y.com>, <https://otro.test', 'x@y.com, <mailto:otro@z.test>', 'no-es-direccion', 'a b@c.test', 'x@y.com?cc=otro@z.test']) {
    assert.throws(() => buildMime({ ...base, unsubscribeMailto: malo }), MimeError, malo);
  }
  const conAsunto = buildMime({ ...base, unsubscribeMailto: 'mailto:baja@app.test?subject=Dar de baja' });
  assert.match(conAsunto, /^List-Unsubscribe: <https:\/\/app\.test\/baja\/abc>, <mailto:baja@app\.test\?subject=Dar%20de%20baja>\r$/m);
});

test('buildMime: List-Unsubscribe de un clic con URL y mailto', () => {
  const mime = buildMime({
    from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y',
    unsubscribeUrl: 'https://app.test/baja/abc', unsubscribeMailto: 'baja@app.test',
  }, { boundary });
  assert.match(mime, /^List-Unsubscribe: <https:\/\/app\.test\/baja\/abc>, <mailto:baja@app\.test>\r$/m);
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m);
  assert.throws(() => buildMime({ from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y', unsubscribeUrl: 'http://inseguro.test' }), MimeError);
});

test('buildMime: multipart/mixed con alternativa HTML y un adjunto con nombre acentuado', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const mime = buildMime({
    from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'Media kit', text: 'Adjunto', html: '<p>Adjunto</p>',
    attachments: [{ filename: 'Media kit – Laura Gómez.pdf', contentType: 'application/pdf', data: pdf }],
  }, { boundary });
  assert.match(mime, /^Content-Type: multipart\/mixed; boundary="b0"\r$/m);
  assert.match(mime, /^Content-Type: multipart\/alternative; boundary="b1"\r$/m);
  assert.match(mime, /Content-Disposition: attachment;\r\n filename\*=UTF-8''Media%20kit%20%E2%80%93%20Laura%20G%C3%B3mez\.pdf\r\n/);
  // Con acentos, el nombre va en la forma extendida de RFC 2231, nunca como encoded-word (RFC 2047 §5 lo prohíbe en parámetros).
  assert.match(mime, /Content-Type: application\/pdf;\r\n name\*=UTF-8''Media%20kit%20%E2%80%93%20Laura%20G%C3%B3mez\.pdf\r\n/);
  assert.ok(!/=\?UTF-8\?B\?/.test(mime.slice(mime.indexOf('application/pdf'))), 'ningún encoded-word en las cabeceras del adjunto');
  assert.match(mime, /\r\nJVBERg==\r\n/);
  assert.ok(mime.trimEnd().endsWith('--b0--'));
});

test('buildMime: el apóstrofo y los paréntesis del nombre de un adjunto van en %XX (el apóstrofo separa charset, idioma y valor)', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const adjunto = (filename: string) => buildMime({
    from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y',
    attachments: [{ filename, contentType: 'application/pdf', data: pdf }],
  }, { boundary });
  const ascii = adjunto("Propuesta d'Ana (v2)*.pdf");
  assert.match(ascii, /\r\n filename\*=UTF-8''Propuesta%20d%27Ana%20%28v2%29%2A\.pdf\r\n/);
  // En ASCII, además, el parámetro de siempre entre comillas para los clientes que no leen RFC 2231.
  assert.match(ascii, /Content-Type: application\/pdf;\r\n name="Propuesta d'Ana \(v2\)\*\.pdf"\r\n/);
  assert.match(ascii, /Content-Disposition: attachment;\r\n filename="Propuesta d'Ana \(v2\)\*\.pdf";\r\n filename\*=/);
  const acentos = adjunto("Cotización d'Ana (final).pdf");
  const valor = /filename\*=UTF-8''(\S+)\r\n/.exec(acentos)![1]!;
  assert.ok(!/['()*]/.test(valor), `sin caracteres reservados en el valor: ${valor}`);
  assert.equal(decodeURIComponent(valor), "Cotización d'Ana (final).pdf", 'y se lee de vuelta tal cual');
  // Unas comillas en el nombre se escapan dentro de la cadena, no rompen el parámetro.
  assert.match(adjunto('Plan "B".pdf'), /name="Plan \\"B\\"\.pdf"/);
});

test('buildMime rechaza la inyección de cabeceras en vez de limpiarla', () => {
  const base = { from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, text: 'y' };
  assert.throws(() => buildMime({ ...base, subject: 'Hola\r\nBcc: todos@x.test' }), MimeError);
  assert.throws(() => buildMime({ ...base, subject: 'x', to: { address: 'c@d.test', name: 'M\nBcc: y' } }), MimeError);
  assert.throws(() => angleId('<a@b>\r\nX: y'), MimeError);
  assert.equal(toGmailRaw('á').includes('='), false, 'base64url sin relleno');
});

test('estado firmado: ida y vuelta, caducidad, firma de otra llave y forma', () => {
  const key = channelStateKey(new Uint8Array(32).fill(7));
  const otra = channelStateKey(new Uint8Array(32).fill(8));
  const now = new Date('2026-09-23T12:00:00Z');
  const state: ChannelState = {
    workspaceId: '00000002-0000-4000-8000-000000000001', creatorId: '00000002-0000-4000-8000-000000000003', channel: 'linkedin',
    nonce: newNonce(() => new Uint8Array(32).fill(1)),
  };
  const token = signChannelState(state, key, now);
  const ok = verifyChannelState(token, key, new Date(now.getTime() + 1000), GOOGLE_STATE_TTL_MS);
  assert.ok(ok.ok && ok.payload.nonce === state.nonce);
  assert.deepEqual(verifyChannelState(token, otra, now, GOOGLE_STATE_TTL_MS), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyChannelState(token, key, new Date(now.getTime() + GOOGLE_STATE_TTL_MS + 1), GOOGLE_STATE_TTL_MS), { ok: false, reason: 'expired' });
  const [body, mac] = token.split('.');
  assert.deepEqual(verifyChannelState(`${body}x.${mac}`, key, now, GOOGLE_STATE_TTL_MS), { ok: false, reason: 'bad_signature' });
  const raro = signChannelState({ ...state, channel: 'whatsapp' as never }, key, now);
  assert.deepEqual(verifyChannelState(raro, key, now, GOOGLE_STATE_TTL_MS), { ok: false, reason: 'bad_shape' });
  assert.equal(pendingAccountId('abc'), 'pending:abc');
});

test('estado firmado: el cuerpo va cifrado (ni el espacio, ni el creador, ni el nonce se leen en la URL) y rota con la llave', () => {
  const vieja = channelStateKey(new Uint8Array(32).fill(3));
  const nueva = channelStateKey(new Uint8Array(32).fill(4));
  const now = new Date('2026-09-23T12:00:00Z');
  const state: ChannelState = {
    workspaceId: '00000002-0000-4000-8000-000000000001', creatorId: '00000002-0000-4000-8000-000000000003', channel: 'email',
    nonce: newNonce(() => new Uint8Array(32).fill(9)),
  };
  const token = signChannelState(state, vieja, now);
  const visible = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
  for (const id of [state.workspaceId, state.creatorId, state.nonce, 'email']) assert.ok(!visible.includes(id), `${id} no se ve`);
  // Firmado con la versión anterior del llavero: se verifica y se descifra con esa.
  const r = verifyChannelState(token, [nueva, vieja], now, GOOGLE_STATE_TTL_MS);
  assert.ok(r.ok);
  assert.deepEqual(r.payload, state);
  // Dos estados iguales no dan el mismo texto (IV al azar).
  assert.notEqual(signChannelState(state, vieja, now), token);
});

test('estado firmado: corto (Unipile lo guarda como `name` de la cuenta) y un estado recortado no abre', () => {
  const key = channelStateKey(new Uint8Array(32).fill(7));
  const now = new Date('2026-09-23T12:00:00Z');
  const state: ChannelState = {
    workspaceId: '00000002-0000-4000-8000-000000000001', creatorId: '00000002-0000-4000-8000-000000000003', channel: 'instagram_dm', nonce: newNonce(),
  };
  const plain = signChannelState(state, key, now);
  const reconnect = signChannelState({ ...state, reconnectAccountId: 'aB3dE5fG7hI9jK1lM3nO5p' }, key, now);
  assert.ok(plain.length <= CHANNEL_STATE_TYPICAL_CHARS, `sin reconexión, ${plain.length} caracteres`);
  assert.ok(reconnect.length < UNIPILE_NAME_WARN_CHARS, `con reconexión, ${reconnect.length} caracteres`);
  const back = verifyChannelState(reconnect, key, now, GOOGLE_STATE_TTL_MS);
  assert.ok(back.ok && back.payload.reconnectAccountId === 'aB3dE5fG7hI9jK1lM3nO5p');
  // Un proveedor que guardara el `name` a medias: ni un carácter menos pasa.
  for (const cut of [plain.length - 1, plain.indexOf('.') + 1, plain.indexOf('.'), 120]) {
    assert.equal(verifyChannelState(plain.slice(0, cut), key, now, GOOGLE_STATE_TTL_MS).ok, false, `recortado a ${cut}`);
  }
  // Un nonce que no es de newNonce (las pruebas usan 'n'.repeat(43)) también va y vuelve.
  const libre = verifyChannelState(signChannelState({ ...state, nonce: 'n'.repeat(43) }, key, now), key, now, GOOGLE_STATE_TTL_MS);
  assert.ok(libre.ok && libre.payload.nonce === 'n'.repeat(43));
  // Un uuid sin forma se firma, pero no se verifica.
  assert.deepEqual(verifyChannelState(signChannelState({ ...state, workspaceId: 'no-es-uuid' }, key, now), key, now, GOOGLE_STATE_TTL_MS), { ok: false, reason: 'bad_shape' });
});

test('openWithAnyKey dice qué llave casó (verifyChannelState descifra con ella, sin repetir el bucle)', () => {
  const vieja = new Uint8Array(32).fill(5);
  const nueva = new Uint8Array(32).fill(6);
  const now = new Date('2026-09-24T12:00:00Z');
  const sealed = sealValue({ x: 1 }, vieja, now);
  const r = openWithAnyKey<{ x: number }>(sealed, [nueva, vieja], now, 60_000);
  assert.ok(r.ok);
  assert.equal(r.key, vieja);
  assert.deepEqual(r.payload, { x: 1 });
  // Caducado con la llave que casa: manda lo que dice esa, sin llave.
  assert.deepEqual(openWithAnyKey(sealed, [nueva, vieja], new Date(now.getTime() + 120_000), 60_000), { ok: false, reason: 'expired' });
  assert.deepEqual(openWithAnyKey(sealed, [nueva], now, 60_000), { ok: false, reason: 'bad_signature' });
});
