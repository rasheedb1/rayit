import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BOUNCE_MIN_ATTEMPTS, buildEmailFooter, complianceReadiness, createOptoutToken, detectBounce, evaluateOutreachAlerts,
  footerTextsFor, listUnsubscribeHeaders, looksLikeOptoutToken, oneClickUnsubscribeUrl, OptoutSecretError, optoutTokenHash,
  optoutUrl, readOptoutToken, warmupDailyLimit, warmupDay, type HealthForAlerts,
} from '../src/outreach/deliverability.ts';

const SECRET = 'secreto-de-prueba-con-mas-de-32-caracteres!!';
const WS = '0000000f-0000-4000-8000-000000000001';
const CONTACT = '0000000f-0000-4000-8000-0000000000c1';
const NONCE = new Uint8Array(16).fill(7);

// ------------------------------------------------------------------ token

test('el token lleva el workspace y la ficha, firmados, y se lee de vuelta', () => {
  const token = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET);
  assert.ok(looksLikeOptoutToken(token));
  assert.ok(token.length >= 16 && token.length <= 200, 'public_optout solo busca tokens de 16 a 200 caracteres');
  assert.deepEqual(readOptoutToken(token, SECRET), { ok: true, workspaceId: WS, contactId: CONTACT });
});

test('dos correos a la misma persona llevan tokens distintos (16 bytes al azar)', () => {
  const a = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET);
  const b = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET);
  assert.notEqual(a, b);
});

test('con el mismo nonce el token es determinista', () => {
  const a = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET, NONCE);
  assert.equal(a, createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET, NONCE));
});

test('cambiar el workspace en la URL rompe la firma', () => {
  const token = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET, NONCE);
  const otro = createOptoutToken({ workspaceId: '0000000f-0000-4000-8000-000000000002', contactId: CONTACT }, SECRET, NONCE);
  const [, , firma] = token.split('.');
  const [v, datosOtro] = otro.split('.');
  assert.deepEqual(readOptoutToken(`${v}.${datosOtro}.${firma}`, SECRET), { ok: false, reason: 'bad_signature' });
});

test('otro secreto no lee el token, y lo que no tiene la forma ni se firma', () => {
  const token = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET);
  assert.deepEqual(readOptoutToken(token, `${SECRET}-otro`), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(readOptoutToken('k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(readOptoutToken(`${token}x`, SECRET), { ok: false, reason: 'malformed' });
});

test('sin secreto, o con uno corto, no se firma ni se lee', () => {
  assert.throws(() => createOptoutToken({ workspaceId: WS, contactId: CONTACT }, ''), OptoutSecretError);
  assert.throws(() => readOptoutToken('v1.x.y', 'corto'), OptoutSecretError);
});

test('los ids tienen que ser uuid', () => {
  assert.throws(() => createOptoutToken({ workspaceId: 'ws-1', contactId: CONTACT }, SECRET), /uuid/);
});

test('el hash es el mismo que calcula public_optout: sha256 hex del token en UTF-8', () => {
  const token = createOptoutToken({ workspaceId: WS, contactId: CONTACT }, SECRET, NONCE);
  assert.equal(optoutTokenHash(token), createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex'));
  assert.match(optoutTokenHash(token), /^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------ URL y cabeceras

test('la URL de baja cuelga de /baja y la de un clic de /baja/<token>/un-clic', () => {
  assert.equal(optoutUrl('https://on-cue-web.vercel.app/', 'v1.a.b'), 'https://on-cue-web.vercel.app/baja/v1.a.b');
  assert.equal(oneClickUnsubscribeUrl('http://localhost:3100', 'v1.a.b'), 'http://localhost:3100/baja/v1.a.b/un-clic');
  assert.throws(() => optoutUrl('javascript:alert(1)', 't'), /http/);
});

test('List-Unsubscribe de un clic (RFC 8058)', () => {
  assert.deepEqual(listUnsubscribeHeaders('https://app.test', 'v1.a.b'), {
    'List-Unsubscribe': '<https://app.test/baja/v1.a.b/un-clic>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});

// ------------------------------------------------------------------ pie

test('sin dirección postal el correo no está listo', () => {
  assert.deepEqual(complianceReadiness({ postalAddress: '  ', unsubscribeUrl: 'https://app.test/baja/x' }), {
    ready: false,
    missing: ['postal_address'],
  });
  assert.deepEqual(buildEmailFooter({ postalAddress: null, unsubscribeUrl: null }), {
    ok: false,
    missing: ['postal_address', 'unsubscribe_link'],
  });
});

test('el pie lleva la frase de baja con el enlace y la dirección, en texto y HTML escapado', () => {
  const r = buildEmailFooter({
    postalAddress: 'Calle 93 # 11-26\nBogotá <Colombia>',
    unsubscribeUrl: 'https://app.test/baja/v1.a.b',
  });
  assert.ok(r.ok);
  assert.match(r.footer.text, /date de baja aquí: https:\/\/app\.test\/baja\/v1\.a\.b/);
  assert.match(r.footer.text, /Calle 93 # 11-26, Bogotá <Colombia>$/);
  assert.match(r.footer.html, /<a href="https:\/\/app\.test\/baja\/v1\.a\.b">date de baja aquí<\/a>/);
  assert.match(r.footer.html, /Bogotá &lt;Colombia&gt;/);
});

test('el pie en inglés para un workspace en inglés', () => {
  const r = buildEmailFooter({ postalAddress: '1 Main St', unsubscribeUrl: 'https://a.test/baja/t', texts: footerTextsFor('en-US') });
  assert.ok(r.ok && r.footer.text.includes('unsubscribe here: https://a.test/baja/t'));
  assert.equal(footerTextsFor('es-CO').unsubscribeLinkLabel, 'date de baja aquí');
});

// ------------------------------------------------------------------ calentamiento

test('calentamiento: 20 la primera semana, sube cada día y llega al tope el día 14', () => {
  const curva = Array.from({ length: 16 }, (_, i) => warmupDailyLimit({ day: i + 1, policyLimit: 100 }));
  assert.deepEqual(curva.slice(0, 7), [20, 20, 20, 20, 20, 20, 20]);
  for (let i = 7; i < 13; i++) assert.ok(curva[i]! > curva[i - 1]!, `el día ${i + 1} sube`);
  assert.equal(curva[13], 100);
  assert.equal(curva[15], 100);
});

test('calentamiento: nunca pasa del tope, y sin calentamiento es el tope', () => {
  assert.equal(warmupDailyLimit({ day: 1, policyLimit: 12 }), 12);
  assert.equal(warmupDailyLimit({ day: 30, policyLimit: 20 }), 20);
  assert.equal(warmupDailyLimit({ day: 1, policyLimit: 150, warmupDays: 0 }), 150);
  assert.equal(warmupDailyLimit({ day: 8, policyLimit: 150, warmupDays: 5 }), 150);
  assert.equal(warmupDailyLimit({ day: 0, policyLimit: 150 }), 20);
});

test('el día del calentamiento se cuenta en la zona del workspace', () => {
  // Conectada el 22 a las 23:00 en Bogotá (04:00 UTC del 23).
  const conectada = new Date('2026-09-23T04:00:00Z');
  assert.equal(warmupDay(conectada, new Date('2026-09-23T04:30:00Z'), 'America/Bogota'), 1);
  assert.equal(warmupDay(conectada, new Date('2026-09-23T06:00:00Z'), 'America/Bogota'), 2);
  assert.equal(warmupDay(conectada, new Date('2026-09-23T06:00:00Z'), 'UTC'), 1);
  assert.equal(warmupDay(conectada, new Date('2026-09-20T00:00:00Z'), 'UTC'), 1);
});

// ------------------------------------------------------------------ rebotes

const GMAIL_NO_EXISTE = {
  from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  subject: 'Delivery Status Notification (Failure)',
  headers: { 'x-failed-recipients': 'mercadeo@marca-que-no-existe.co' },
  body: [
    "** Address not found **",
    '',
    "Your message wasn't delivered to mercadeo@marca-que-no-existe.co because the address couldn't be found, or is unable to receive mail.",
    '',
    'The response from the remote server was:',
    '550 5.1.1 The email account that you tried to reach does not exist.',
    '',
    'Final-Recipient: rfc822; mercadeo@marca-que-no-existe.co',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.',
    '',
    '---------- Forwarded message ----------',
    'From: Laura <laura@gmail.com>',
    'To: mercadeo@marca-que-no-existe.co',
    'Message-ID: <CAF=abc123@mail.gmail.com>',
    'Subject: Una idea para su campaña de otoño',
  ].join('\n'),
};

test('rebote duro de Gmail: dirección, código y el Message-ID del original', () => {
  assert.deepEqual(detectBounce(GMAIL_NO_EXISTE), {
    kind: 'hard',
    statusCode: '5.1.1',
    smtpCode: 550,
    recipient: 'mercadeo@marca-que-no-existe.co',
    originalMessageId: 'CAF=abc123@mail.gmail.com',
    reason: '550-5.1.1 The email account that you tried to reach does not exist.',
  });
});

test('un DSN de Postfix con user unknown, sin Status, es duro', () => {
  const r = detectBounce({
    from: 'MAILER-DAEMON@mx.ejemplo.com (Mail Delivery System)',
    subject: 'Undelivered Mail Returned to Sender',
    body: '<ana@ejemplo.com>: host mx.ejemplo.com said: 550 User unknown (in reply to RCPT TO command)',
  });
  assert.equal(r?.kind, 'hard');
  assert.equal(r?.smtpCode, 550);
});

test('buzón lleno y 4xx son blandos; 5.7.1 es bloqueo, no correo inválido', () => {
  const lleno = detectBounce({
    from: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    body: 'Status: 5.2.2\nDiagnostic-Code: smtp; 552 5.2.2 The recipient mailbox is full',
  });
  assert.equal(lleno?.kind, 'soft');
  const temporal = detectBounce({
    from: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Delay)',
    body: 'Status: 4.4.1\nDiagnostic-Code: smtp; 421 4.4.1 Connection timed out',
  });
  assert.equal(temporal?.kind, 'soft');
  const bloqueo = detectBounce({
    from: 'postmaster@outlook.com',
    subject: 'Undeliverable: Propuesta',
    body: 'Final-Recipient: rfc822; compras@marca.com\nStatus: 5.7.1\nDiagnostic-Code: smtp; 550 5.7.1 Message rejected due to policy',
  });
  assert.equal(bloqueo?.kind, 'blocked');
  assert.equal(bloqueo?.recipient, 'compras@marca.com');
});

test('un aviso en español también se reconoce', () => {
  const r = detectBounce({
    from: 'Sistema de entrega de correo <mailer-daemon@googlemail.com>',
    subject: 'No se ha podido entregar el mensaje',
    body: 'La dirección no se encontró. Final-Recipient: rfc822; hola@tienda.co\nStatus: 5.1.1',
  });
  assert.equal(r?.kind, 'hard');
  assert.equal(r?.recipient, 'hola@tienda.co');
});

test('una respuesta normal no es un rebote, aunque hable de entregas', () => {
  assert.equal(
    detectBounce({ from: 'Valentina <valentina@cafealma.co>', subject: 'Re: Delivery failed?', body: 'Hola, sí nos llegó.' }),
    null,
  );
  assert.equal(detectBounce({ from: 'mailer-daemon@googlemail.com', subject: 'Tu resumen semanal', body: 'Nada que ver.' }), null);
});

// ------------------------------------------------------------------ alertas

function salud(over: Partial<HealthForAlerts> = {}): HealthForAlerts {
  return {
    enabled: true,
    queue: { stuck: 0 },
    window: { sent: 12 },
    accountsDown: 0,
    llm: { spentToday: 1.2, dailyCap: 5 },
    ...over,
  };
}

test('un workspace sano no alerta', () => {
  assert.deepEqual(evaluateOutreachAlerts({ health: salud(), emailAttempts: 40, bounces: 2, activeEnrollments: 5 }), []);
});

test('rebotes sobre el 5 % solo con diez intentos o más', () => {
  const pocos = evaluateOutreachAlerts({ health: salud(), emailAttempts: BOUNCE_MIN_ATTEMPTS - 1, bounces: 5, activeEnrollments: 1 });
  assert.deepEqual(pocos, []);
  const justo = evaluateOutreachAlerts({ health: salud(), emailAttempts: 20, bounces: 1, activeEnrollments: 1 });
  assert.deepEqual(justo, [], 'el 5 % exacto no alerta: es «sobre»');
  const [a] = evaluateOutreachAlerts({ health: salud(), emailAttempts: 20, bounces: 2, activeEnrollments: 1 });
  assert.equal(a?.kind, 'bounce_rate');
  assert.equal(a?.values.rate, 0.1);
});

test('cero envíos con enrolamientos activos alerta, salvo con el envío apagado', () => {
  const sinEnvios = salud({ window: { sent: 0 } });
  assert.deepEqual(
    evaluateOutreachAlerts({ health: sinEnvios, emailAttempts: 0, bounces: 0, activeEnrollments: 3 }).map((a) => a.kind),
    ['no_sends'],
  );
  assert.deepEqual(evaluateOutreachAlerts({ health: { ...sinEnvios, enabled: false }, emailAttempts: 0, bounces: 0, activeEnrollments: 3 }), []);
  assert.deepEqual(evaluateOutreachAlerts({ health: sinEnvios, emailAttempts: 0, bounces: 0, activeEnrollments: 0 }), []);
});

test('cola atascada, cuenta caída y presupuesto agotado, cada una con su tipo', () => {
  const r = evaluateOutreachAlerts({
    health: salud({ queue: { stuck: 2 }, accountsDown: 1, llm: { spentToday: 5, dailyCap: 5 } }),
    emailAttempts: 5,
    bounces: 0,
    activeEnrollments: 1,
  });
  assert.deepEqual(r.map((a) => [a.kind, a.severity]), [
    ['queue_stuck', 'warning'],
    ['account_down', 'critical'],
    ['llm_budget', 'warning'],
  ]);
});
