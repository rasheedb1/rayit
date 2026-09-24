import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  BOUNCE_MIN_ATTEMPTS, buildEmailFooter, complianceReadiness, createOptoutToken, detectBounce, evaluateOutreachAlerts,
  footerTextsFor, listUnsubscribeHeaders, looksLikeOptoutToken, maskEmailAddress, oneClickUnsubscribeUrl, optoutTokenHash,
  channelAccountLabel, optoutUrl, URGENT_ALERT_KINDS, warmupCurve, warmupDailyLimit, warmupSeries, warmupDay, WARMUP_START_LIMIT, type AlertInput, type HealthForAlerts,
} from '../src/outreach/deliverability.ts';

// ------------------------------------------------------------------ token

test('el token es opaco: 32 bytes al azar en base64url, sin ningún id dentro', () => {
  const token = createOptoutToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(looksLikeOptoutToken(token));
  assert.ok(!token.includes('.'), 'sin puntos: el optoutUrl de VEN-10 (^[A-Za-z0-9_-]{16,128}$) lo acepta');
  const fijo = createOptoutToken((n) => new Uint8Array(n).fill(7));
  assert.equal(fijo, Buffer.alloc(32, 7).toString('base64url'));
  assert.throws(() => createOptoutToken(() => new Uint8Array(8)), /32 bytes/);
});

test('dos correos a la misma persona llevan tokens distintos', () => {
  assert.notEqual(createOptoutToken(), createOptoutToken());
});

test('el token del despachador de VEN-10 tiene la misma forma: un solo contrato', () => {
  // outreach-motor.ts (VEN-10) genera randomBytes(32).toString('base64url').
  const deVen10 = randomBytes(32).toString('base64url');
  assert.ok(looksLikeOptoutToken(deVen10));
  // Y un token hex de 64, o uno v1 de la ronda 1, también se busca: la base decide.
  assert.ok(looksLikeOptoutToken('a'.repeat(64)));
  assert.ok(looksLikeOptoutToken(`v1.${'A'.repeat(64)}.${'b'.repeat(22)}`));
});

test('lo que no tiene forma de token no llega a la base', () => {
  assert.equal(looksLikeOptoutToken(''), false);
  assert.equal(looksLikeOptoutToken('corto'), false);
  assert.equal(looksLikeOptoutToken('x'.repeat(201)), false);
  assert.equal(looksLikeOptoutToken("abc'; drop table contact;--xxxxxxxx"), false);
  assert.equal(looksLikeOptoutToken(undefined), false);
});

test('el hash es el mismo que calcula public_optout: sha256 hex del token en UTF-8', () => {
  const token = createOptoutToken((n) => new Uint8Array(n).fill(1));
  assert.equal(optoutTokenHash(token), createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex'));
  assert.match(optoutTokenHash(token), /^[0-9a-f]{64}$/);
});

test('la dirección enmascarada deja la inicial y el dominio', () => {
  assert.equal(maskEmailAddress('Valentina@Marca.com'), 'v•••@marca.com');
  assert.equal(maskEmailAddress('a@b.co'), 'a•••@b.co');
  assert.equal(maskEmailAddress('sin-arroba'), '•••');
});

// ------------------------------------------------------------------ URL y cabeceras

test('la URL de baja cuelga de /baja y la de un clic de /baja/<token>/un-clic', () => {
  const token = createOptoutToken((n) => new Uint8Array(n).fill(2));
  assert.equal(optoutUrl('https://on-cue-web.vercel.app/', token), `https://on-cue-web.vercel.app/baja/${token}`);
  assert.equal(oneClickUnsubscribeUrl('http://localhost:3100', token), `http://localhost:3100/baja/${token}/un-clic`);
  assert.throws(() => optoutUrl('javascript:alert(1)', token), /http/);
});

test('List-Unsubscribe de un clic (RFC 8058)', () => {
  assert.deepEqual(listUnsubscribeHeaders('https://app.test', 'tok-de-prueba-123'), {
    'List-Unsubscribe': '<https://app.test/baja/tok-de-prueba-123/un-clic>',
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
  assert.equal(warmupDailyLimit({ day: 1, policyLimit: 150, warmupDays: 1 }), 150);
  assert.equal(warmupDailyLimit({ day: 5, policyLimit: 150, warmupDays: 5 }), 150);
  assert.equal(warmupDailyLimit({ day: 0, policyLimit: 150 }), 20);
});

test('un calentamiento corto recorta la meseta y sigue subiendo poco a poco (sin saltos de 20 al tope)', () => {
  const dias = (hasta: number) => Array.from({ length: hasta }, (_, i) => warmupDailyLimit({ day: i + 1, policyLimit: 60, warmupDays: hasta }));
  assert.deepEqual(dias(5), [20, 20, 33, 46, 60]);
  assert.deepEqual(dias(8), [20, 20, 20, 20, 30, 40, 50, 60]);
  assert.deepEqual(dias(2), [20, 60], 'con dos días, el segundo ya es el tope: es lo que se pidió');
});

test('la curva de la pantalla y el motor dicen lo mismo para 0 a 21 días de calentamiento', () => {
  for (const tope of [15, 20, 21, 60, 2000]) {
    for (let hasta = 0; hasta <= 21; hasta++) {
      const motor = Array.from({ length: hasta + 3 }, (_, i) => warmupDailyLimit({ day: i + 1, policyLimit: tope, warmupDays: hasta }));
      const curva = warmupCurve(tope, hasta);
      const hayCalentamiento = motor.some((n) => n < tope);
      assert.equal(curva.length > 0, hayCalentamiento, `tope ${tope}, ${hasta} días`);
      for (const p of curva) assert.equal(p.limit, motor[p.day - 1], `tope ${tope}, ${hasta} días, día ${p.day}`);
      for (let i = 1; i < motor.length; i++) assert.ok(motor[i]! >= motor[i - 1]!, `nunca baja (tope ${tope}, ${hasta} días)`);
      if (curva.length) {
        assert.equal(curva[0]?.day, 1);
        assert.equal(curva.at(-1)?.limit, tope, 'la curva termina en el tope');
        assert.equal(curva.at(-1)?.day, motor.indexOf(tope) + 1, 'en el primer día que lo alcanza');
      }
    }
  }
});

test('la curva enseña el primer día, el primero que sube, uno intermedio y el del tope', () => {
  assert.deepEqual(warmupCurve(100, 14).map((p) => p.day), [1, 8, 11, 14]);
  assert.deepEqual(warmupCurve(100, 14).map((p) => p.limit), [20, 31, 65, 100]);
  assert.deepEqual(warmupCurve(WARMUP_START_LIMIT, 14), [], 'con un tope de 20 no hay nada que calentar');
  assert.deepEqual(warmupCurve(100, 0), []);
  assert.deepEqual(warmupCurve(100, 10_000), [], 'un valor fuera de rango no se pinta');
});

test('la rampa del gráfico: un punto por día hasta el tope, y los días de warmupCurve están en ella', () => {
  const serie = warmupSeries(80, 14);
  assert.deepEqual(serie.map((p) => p.day), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.deepEqual(serie.slice(0, 7).map((p) => p.limit), Array(7).fill(WARMUP_START_LIMIT), 'la primera semana, 20');
  assert.equal(serie.at(-1)?.limit, 80);
  for (const p of warmupCurve(80, 14)) assert.equal(serie[p.day - 1]?.limit, p.limit);
  for (let i = 1; i < serie.length; i++) assert.ok(serie[i]!.limit >= serie[i - 1]!.limit, 'nunca baja');
  assert.deepEqual(warmupSeries(WARMUP_START_LIMIT, 14), []);
  assert.deepEqual(warmupSeries(100, 0), []);
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

test('un fuera de oficina de postmaster@ que dice «no existe» no es un rebote', () => {
  // La prueba del hallazgo: antes daba 'hard' y, con In-Reply-To, marcaba
  // como inválida una dirección que funciona.
  const ausente = {
    from: 'Postmaster <postmaster@marca.com>',
    subject: 'Fuera de la oficina',
    headers: { 'in-reply-to': '<CAF=abc123@mail.gmail.com>' },
    body: 'Estoy fuera hasta el lunes: el evento no existe hasta el lunes. The office does not exist on weekends.',
  };
  assert.equal(detectBounce(ausente), null);
  // Con asunto de rebote pero sin nada del servidor, no se inventa un «duro».
  const vago = detectBounce({
    from: 'postmaster@marca.com',
    subject: 'Undeliverable: Propuesta',
    body: 'Hola, el formulario de contacto no existe más; escríbenos por la web.',
  });
  assert.notEqual(vago?.kind, 'hard');
});

test('«no existe» cuenta cuando lo dice el servidor sobre la dirección', () => {
  const r = detectBounce({
    from: 'MAILER-DAEMON@mx.tienda.co',
    subject: 'Mensaje no entregado',
    body: 'No pudimos entregar tu mensaje.\nhost mx.tienda.co said: 550 El buzón hola@tienda.co no existe',
  });
  assert.equal(r?.kind, 'hard');
  assert.equal(r?.smtpCode, 550);
  assert.match(r?.reason ?? '', /no existe/);
});

test('un DSN que no viene de mailer-daemon ni de postmaster no es un aviso (r3)', () => {
  // Cualquiera puede escribir «Status: 5.1.1» en un correo normal: sin el
  // remitente de rebote, un aviso falso marcaba como inválida una
  // dirección que funciona (y, con un contacto global, en otro workspace).
  const falso = detectBounce({
    from: 'Yo <yo@a.test>',
    subject: 'Hola',
    body: 'Final-Recipient: rfc822; valentina@marca.test\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown',
  });
  assert.equal(falso, null);
});

test('el aviso de Gmail sin cabeceras DSN: el destinatario sale entero de la prosa, en inglés y en español', () => {
  const ingles = detectBounce({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
    body:
      "** Address not found **\n\nYour message wasn't delivered to nadie@marca.co because the address couldn't be found.\n\n" +
      'The response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.',
  });
  assert.equal(ingles?.recipient, 'nadie@marca.co', 'no se corta en el primer punto del dominio');
  assert.equal(ingles?.kind, 'hard');
  const espanol = detectBounce({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Notificación de estado de la entrega (error)',
    body:
      'No se ha encontrado la dirección\n\nTu mensaje no se ha entregado a compras@tienda.com.co porque no se ha encontrado la dirección.\n\n' +
      'La respuesta del servidor remoto fue:\n550 5.1.1 The email account that you tried to reach does not exist.',
  });
  assert.equal(espanol?.recipient, 'compras@tienda.com.co');
  assert.equal(espanol?.kind, 'hard');
});

test('un dominio que no existe es un rebote duro, con o sin código', () => {
  const gmail = detectBounce({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
    body: [
      '** Address not found **',
      '',
      "Your message wasn't delivered to x@dominio-que-no-existe.co because the domain dominio-que-no-existe.co couldn't be found. " +
        'Check for typos or unnecessary spaces and try again.',
      '',
      "The response was:\nDNS Error: DNS type 'mx' lookup of dominio-que-no-existe.co responded with code NXDOMAIN",
    ].join('\n'),
  });
  assert.equal(gmail?.kind, 'hard');
  assert.equal(gmail?.statusCode, null);
  assert.equal(gmail?.recipient, 'x@dominio-que-no-existe.co');
  assert.match(gmail?.reason ?? '', /couldn't be found|NXDOMAIN/);

  const postfix = detectBounce({
    from: 'MAILER-DAEMON@mx.ejemplo.com (Mail Delivery System)',
    subject: 'Undelivered Mail Returned to Sender',
    body: '<ana@nada.test>: Host or domain name not found. Name service error for name=nada.test type=MX: Host not found',
  });
  assert.equal(postfix?.kind, 'hard');
  for (const frase of ['unrouteable address', 'no MX record for domain', 'Domain not found']) {
    const r = detectBounce({ from: 'mailer-daemon@mx.test', subject: 'Mail delivery failed', body: `ana@nada.test\n${frase}` });
    assert.equal(r?.kind, 'hard', frase);
  }
  const espanol = detectBounce({
    from: 'mailer-daemon@googlemail.com',
    subject: 'Mensaje no entregado',
    body: 'Tu mensaje no se ha entregado a hola@nada.co porque no se ha encontrado el dominio nada.co.',
  });
  assert.equal(espanol?.kind, 'hard');
  assert.equal(espanol?.recipient, 'hola@nada.co');
  // Un fallo pasajero del DNS (SERVFAIL) no es un dominio inexistente.
  const pasajero = detectBounce({
    from: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    body: "DNS Error: DNS type 'mx' lookup of marca.co responded with code SERVFAIL",
  });
  assert.equal(pasajero?.kind, 'soft');
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

function entrada(over: Partial<AlertInput> = {}): AlertInput {
  return { health: salud(), emailsSent: 40, hardBounces: 0, dueToSend: 0, ...over };
}

test('un workspace sano no alerta', () => {
  assert.deepEqual(evaluateOutreachAlerts(entrada({ hardBounces: 2, dueToSend: 5 })), []);
});

test('un Gmail cuyo buzón de rebotes nadie lee avisa (r5); sin el dato, como 0', () => {
  assert.deepEqual(evaluateOutreachAlerts(entrada({ unreadMailboxes: 0 })), []);
  assert.deepEqual(evaluateOutreachAlerts(entrada()), [], 'un fixture de antes, sin el campo');
  assert.deepEqual(evaluateOutreachAlerts(entrada({ unreadMailboxes: 2 })), [
    { kind: 'bounces_unread', severity: 'warning', values: { mailboxes: 2 } },
  ]);
});

test('lo urgente, que no espera al resumen de mañana, es lo crítico: la cuenta caída y los rebotes (r5)', () => {
  assert.deepEqual([...URGENT_ALERT_KINDS].sort(), ['account_down', 'bounce_rate']);
  const todas = evaluateOutreachAlerts(
    entrada({ emailsSent: 20, hardBounces: 5, dueToSend: 3, unreadMailboxes: 1,
      health: salud({ accountsDown: 1, queue: { stuck: 1 }, window: { sent: 0 }, llm: { spentToday: 6, dailyCap: 5 } }) }),
  );
  assert.deepEqual(
    todas.filter((a) => a.severity === 'critical').map((a) => a.kind).sort(),
    [...URGENT_ALERT_KINDS].sort(),
  );
});

test('rebotes duros sobre el 5 % solo con diez envíos o más', () => {
  assert.deepEqual(evaluateOutreachAlerts(entrada({ emailsSent: BOUNCE_MIN_ATTEMPTS - 1, hardBounces: 5 })), []);
  assert.deepEqual(evaluateOutreachAlerts(entrada({ emailsSent: 20, hardBounces: 1 })), [], 'el 5 % exacto no alerta: es «sobre»');
  const [a] = evaluateOutreachAlerts(entrada({ emailsSent: 20, hardBounces: 2 }));
  assert.equal(a?.kind, 'bounce_rate');
  assert.equal(a?.values.rate, 0.1);
});

test('3 rebotes blandos sobre 20 no alertan: solo cuentan los duros', () => {
  // Quien lee la salud pasa solo los duros (outbound.alerts: kind = 'hard');
  // tres blandos son 0 duros.
  assert.deepEqual(evaluateOutreachAlerts(entrada({ emailsSent: 20, hardBounces: 0 })), []);
});

test('la tasa nunca pasa del 100 %', () => {
  const [a] = evaluateOutreachAlerts(entrada({ emailsSent: 10, hardBounces: 30 }));
  assert.equal(a?.values.rate, 1);
  assert.equal(a?.values.bounces, 10);
});

test('cero envíos alerta solo si había toques que tocaba enviar, y con el envío encendido', () => {
  const sinEnvios = salud({ window: { sent: 0 } });
  assert.deepEqual(
    evaluateOutreachAlerts(entrada({ health: sinEnvios, emailsSent: 0, dueToSend: 3 })).map((a) => [a.kind, a.values.dueToSend]),
    [['no_sends', 3]],
  );
  assert.deepEqual(evaluateOutreachAlerts(entrada({ health: { ...sinEnvios, enabled: false }, emailsSent: 0, dueToSend: 3 })), []);
});

test('un fin de semana sin toques debidos no alerta, aunque haya secuencias activas', () => {
  // Sábado y domingo el despachador no envía y nada estaba programado:
  // dueToSend = 0. Antes bastaban los enrolamientos activos para avisar.
  assert.deepEqual(evaluateOutreachAlerts(entrada({ health: salud({ window: { sent: 0 } }), emailsSent: 0, dueToSend: 0 })), []);
});

test('cola atascada, cuenta caída y presupuesto agotado, cada una con su tipo', () => {
  const r = evaluateOutreachAlerts(
    entrada({ health: salud({ queue: { stuck: 2 }, accountsDown: 1, llm: { spentToday: 5, dailyCap: 5 } }), emailsSent: 5 }),
  );
  assert.deepEqual(r.map((a) => [a.kind, a.severity]), [
    ['queue_stuck', 'warning'],
    ['account_down', 'critical'],
    ['llm_budget', 'warning'],
  ]);
});

test('el nombre de una cuenta no repite el canal si ya lo lleva', () => {
  assert.equal(channelAccountLabel('LinkedIn', 'Laura · Cocina fácil'), 'LinkedIn: Laura · Cocina fácil');
  assert.equal(channelAccountLabel('LinkedIn', 'Laura · Cocina fácil (LinkedIn)'), 'Laura · Cocina fácil (LinkedIn)');
  assert.equal(channelAccountLabel('Gmail', 'laura@gmail.com'), 'Gmail: laura@gmail.com');
  assert.equal(channelAccountLabel('Instagram', ''), 'Instagram');
});
