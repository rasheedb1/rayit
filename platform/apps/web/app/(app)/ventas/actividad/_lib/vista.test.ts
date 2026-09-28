import { describe, expect, it } from "vitest";
import { retryScheduledFor, type QueueBlockers, type QueueRow } from "@mc/db/queries/actividad";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { filaVista } from "./filas";
import { codigoDeMotivo, filtrosDe, hayFiltros, hrefDe, motivoDe, resumenDe } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
/** El reloj de las pruebas: la fecha corta lleva año solo si no es el de «hoy», así que se fija. */
const HOY = new Date("2026-09-25T15:00:00Z");
const vista = (r: QueueRow, bloqueos: QueueBlockers | null = null) => filaVista(r, f, { bloqueos, now: HOY });
const corta = (iso: string) => f.dateTimeShort(iso, HOY);
/** Nada para la cola: el envío encendido y todos los canales con cuenta. */
const LIBRE: QueueBlockers = { outreachEnabled: true, channelsWithoutAccount: [], channelsNotAllowed: [] };

const fila = (over: Partial<QueueRow> = {}): QueueRow => ({
  touchId: "00000065-0000-4000-8000-000000000733",
  status: "failed",
  bucket: "queue",
  channel: "linkedin",
  subject: null,
  sequenceId: "00000065-0000-4000-8000-00000000005e",
  sequenceName: "Semana de prueba",
  stepId: "00000065-0000-4000-8000-000000005e03",
  stepType: "linkedin_message",
  stepPosition: 3,
  stepDayOffset: 4,
  enrollmentStatus: "completed",
  sequenceStatus: "active",
  contactId: "00000065-0000-4000-8000-0000000000d3",
  contactName: "Persona 3",
  contactEmail: "c3@marca.test",
  companyId: "00000065-0000-4000-8000-0000000000c0",
  companyName: "Marca A",
  accountName: "Laura Méndez",
  accountStatus: "connected",
  attemptCount: 5,
  dueAt: null,
  retrying: false,
  statusChangedAt: new Date("2026-09-23T15:30:00Z"),
  sentAt: null,
  openedAt: null,
  repliedAt: null,
  reason: "max_attempts",
  retryBlock: null,
  retryable: true,
  cancelable: true,
  ...over,
});

describe("los filtros de la URL", () => {
  it("leen la pestaña y los tres filtros, y vuelven a la misma URL", () => {
    const filtros = filtrosDe({ vista: "historial", cadencia: "abc", tipo: "email", contacto: " sofía " });
    expect(filtros).toEqual({ vista: "history", cadencia: "abc", tipo: "email", contacto: "sofía", pagina: null });
    expect(hrefDe(filtros)).toBe("/ventas/actividad?vista=historial&cadencia=abc&tipo=email&contacto=sof%C3%ADa");
    expect(hayFiltros(filtros)).toBe(true);
  });

  it("sin nada, la cola y la URL desnuda; lo desconocido se ignora", () => {
    const filtros = filtrosDe({ vista: "otra", contacto: "   " });
    expect(filtros).toEqual({ vista: "queue", cadencia: null, tipo: null, contacto: null, pagina: null });
    expect(hrefDe(filtros)).toBe("/ventas/actividad");
    expect(hayFiltros(filtros)).toBe(false);
  });

  it("la página viaja en la URL solo si tiene la forma de un cursor, y no cuenta como filtro", () => {
    const id = "00000065-0000-4000-8000-00000000007a";
    const antiguo = `2026-09-24T15:30:00.123456Z_${id}`;
    const f = filtrosDe({ vista: "historial", siguiente: antiguo });
    expect(f.pagina).toEqual({ direction: "next", token: antiguo });
    expect(hrefDe(f)).toBe(`/ventas/actividad?vista=historial&siguiente=${encodeURIComponent(antiguo)}`);
    expect(hayFiltros(f)).toBe(false);
    expect(filtrosDe({ anterior: `0_infinity_${id}` }).pagina).toEqual({ direction: "prev", token: `0_infinity_${id}` });
    for (const malo of ["1; DROP TABLE", "2026-09-24_x", `2_infinity_${id}`, `${antiguo}_otra`]) {
      expect(filtrosDe({ siguiente: malo }).pagina, malo).toBeNull();
    }
  });
});

describe("el motivo de un mensaje", () => {
  it("un retenido dice por qué espera, con la frase de la ficha", () => {
    expect(motivoDe("held", "placeholders:{{first_name}}")).toMatch(/^[A-ZÁÉÍÓÚ]/);
    expect(motivoDe("held", "placeholders:{{first_name}}")).toContain("{{first_name}}");
  });

  it("un fallido dice qué pasó con el proveedor; un cancelado, por qué no salió", () => {
    expect(motivoDe("failed", "max_attempts")).toBe("Fallaron los cinco intentos");
    expect(motivoDe("canceled", "canceled_by_user")).toBe("Lo cancelaste desde la actividad");
    expect(motivoDe("canceled", "replied")).toBe("Respondió y la cadencia se detuvo");
  });

  it("un código desconocido no se enseña crudo en la fila, pero sí en el detalle (para soporte)", () => {
    expect(motivoDe("canceled", "algo_raro")).toBe("No salió");
    expect(codigoDeMotivo("canceled", "algo_raro")).toBe("código: algo_raro");
    expect(codigoDeMotivo("failed", "rejected:550 5.7.1")).toBe("código: rejected:550 5.7.1");
    expect(motivoDe("scheduled", null)).toBeNull();
    // Un nombre de propiedad de Object no es un motivo.
    expect(motivoDe("canceled", "toString")).toBe("No salió");
  });

  it("un motivo de texto libre no se rotula «código»: ya se lee entero en la fila", () => {
    const libre = "El juez dejó 7,6 de 8,0: cita una campaña que no está en tu perfil.";
    // Retenido con una frase heredada (no es un código de HOLD_CODES): la fila la dice tal cual, sin su punto…
    expect(motivoDe("held", libre)).toBe("El juez dejó 7,6 de 8,0: cita una campaña que no está en tu perfil");
    // …y el detalle no la repite como si fuera un código.
    expect(codigoDeMotivo("held", libre)).toBeNull();
    expect(vista(fila({ status: "held", reason: libre, retryable: false })).motivoCodigo).toBeNull();
    // Un código de verdad, sí: el de la retención (con su dato) y el de un fallido.
    expect(codigoDeMotivo("held", "quality_low:7.6")).toBe("código: quality_low:7.6");
    expect(codigoDeMotivo("canceled", "Lo cancelé yo")).toBeNull();
  });

  it("en un espacio en inglés, el motivo va en el idioma de la interfaz: la fila no mezcla dos idiomas", () => {
    const en = formatterFor({ locale: "en-US", currency: "USD", timezone: "America/New_York" });
    const v = filaVista(fila(), en, { now: HOY });
    expect(v.estado).toBe("Falló");
    expect(v.titulo).toBe("Paso 3 · Mensaje en LinkedIn");
    expect(v.motivo).toBe("Fallaron los cinco intentos");
    const retenido = filaVista(fila({ status: "held", reason: "needs_review", retryable: false }), en, { now: HOY });
    expect(retenido.motivo).toMatch(/^Espera tu aprobación/);
    // Las cifras y las fechas sí siguen el locale del espacio.
    expect(v.cuando).toBe(en.dateTimeShort("2026-09-23T15:30:00Z", HOY));
    expect(v.cuando).toMatch(/^Sep 23/);
  });
});

describe("el resumen de una acción en masa", () => {
  it("dice cuántos se movieron y, de los demás, cuántos por cada motivo", () => {
    const texto = resumenDe(
      {
        done: ["a", "b"],
        skipped: [{ touchId: "c", code: "superseded" }, { touchId: "d", code: "superseded" }, { touchId: "e", code: "not_retryable" }],
      },
      MESSAGES.resultado.reintentados,
      MESSAGES.resultado.reintento,
      f,
    );
    expect(texto).toBe(
      "2 mensajes volvieron a la cola. 3 no se movieron: 2 · ya salió un paso posterior, 1 · rebotó o pudo haber salido.",
    );
    expect(resumenDe({ done: [], skipped: [] }, MESSAGES.resultado.cancelados, MESSAGES.resultado.cancelacion, f)).toBe("Nada cambió.");
    expect(resumenDe({ done: ["a"], skipped: [] }, MESSAGES.resultado.cancelados, MESSAGES.resultado.cancelacion, f)).toBe(
      "1 mensaje cancelado.",
    );
  });
});

describe("una fila de la cola", () => {
  it("el fallido: paso, a quién, cuándo falló (solo la fecha al lado de la pastilla; el verbo en la larga), intentos, cuenta y su motivo", () => {
    const v = vista(fila());
    expect(v.estado).toBe("Falló");
    expect(v.estadoKind).toBe("bad");
    expect(v.titulo).toBe("Paso 3 · Mensaje en LinkedIn");
    expect(v.paso).toBeNull();
    expect(v.contacto).toBe("Persona 3");
    expect(v.contexto).toBe("Marca A · Semana de prueba");
    expect(v.intentos).toBe("5 intentos");
    expect(v.cuenta).toBe("Desde Laura Méndez");
    expect(v.motivo).toBe("Fallaron los cinco intentos");
    expect(v.motivoCodigo).toBe("código: max_attempts");
    expect(v.motivoTono).toBe("bad");
    expect([v.reintentable, v.bloqueo, v.reconectar]).toEqual([true, null, null]);
    // La pastilla ya dice «Falló»: al lado va solo la fecha, sin repetir el verbo.
    expect(v.cuando).toBe(corta("2026-09-23T15:30:00Z"));
    expect(v.queEs).toBe("Paso 3 · Mensaje en LinkedIn");
    expect(v.cuandoCompleto).toBe(`Falló ${f.dateTime("2026-09-23T15:30:00Z")}`);
    expect(v.cuando).not.toContain("2026");
    expect(v.fichaHref).toBe("/ventas/empresas/00000065-0000-4000-8000-0000000000c0");
  });

  it("un fallido bloqueado dice por qué, con la frase del resumen; uno de la cuenta caída lleva a reconectar", () => {
    const rebote = vista(fila({ reason: "bounced", retryBlock: "not_retryable", retryable: false }));
    expect([rebote.reintentable, rebote.bloqueo, rebote.reconectar]).toEqual([false, "No se reintenta: rebotó o pudo haber salido.", null]);
    const lleno = vista(fila({ attemptCount: 19, retryBlock: "too_many_attempts", retryable: false }));
    expect(lleno.bloqueo).toBe("No se reintenta: ya gastó todos sus intentos.");
    const caida = vista(fila({ reason: "account_auth", retryBlock: "account_down", retryable: false, accountStatus: "needs_reconnect" }));
    // Lleva a la fila de su canal en /ventas/canales, donde está el botón de reconectar.
    expect([caida.reintentable, caida.bloqueo, caida.reconectar]).toEqual([false, null, "/ventas/canales#canal-linkedin-titulo"]);
    expect(caida.motivoCodigo).toBe("código: account_auth");
  });

  it("lo que ya no sale: la pastilla dice el verbo, al lado solo la fecha, y la frase entera en la larga; lo que se envía, desde cuándo", () => {
    const at = "2026-09-23T15:30:00Z";
    const base = { reason: null, retryable: false };
    const cancelado = vista(fila({ ...base, status: "canceled", bucket: "history" }));
    expect([cancelado.estado, cancelado.cuando, cancelado.cuandoCompleto]).toEqual(["Cancelado", corta(at), `Se canceló ${f.dateTime(at)}`]);
    const saltado = vista(fila({ ...base, status: "skipped", bucket: "history" }));
    expect([saltado.cuando, saltado.cuandoCompleto]).toEqual([corta(at), `Se saltó ${f.dateTime(at)}`]);
    const enviando = vista(fila({ ...base, status: "processing" }));
    expect([enviando.estado, enviando.cuando, enviando.cuandoCompleto]).toEqual([
      "Enviando", `Desde ${corta(at)}`, `Enviándose desde ${f.dateTime(at)}`,
    ]);
  });

  it("un reintento hecho fuera de horario dice la hora a la que sale de verdad, no la del clic", () => {
    // retryFailedTouches deja scheduled_for en la apertura de la ventana (retryScheduledFor): un viernes a las 20:00 de
    // Bogotá, el lunes a las 08:12. La fila dice esa hora, en la zona del espacio.
    const viernes = new Date("2026-09-26T01:00:00Z");
    const lunes = retryScheduledFor("00000065-0000-4000-8000-0000000000f1", viernes, "America/Bogota", { start: "08:00", end: "18:00" });
    const v = vista(fila({ status: "scheduled", reason: null, retryable: false, retryBlock: null, dueAt: lunes }));
    expect(v.cuando).toBe(`Sale ${corta(lunes.toISOString())}`);
    expect(v.cuandoCompleto).toMatch(/^Sale 28 de septiembre de 2026 a las 8:[0-2]\d a\. m\.$/);
  });

  it("un correo programado dice cuándo sale; uno que se reintenta, cuándo es el reintento", () => {
    const due = new Date("2026-09-26T15:30:00Z");
    const base = { status: "scheduled" as const, channel: "email" as const, subject: "Hola, Sofía", reason: null, retryable: false, dueAt: due };
    expect(vista(fila(base)).cuando).toBe(`Sale ${corta(due.toISOString())}`);
    expect(vista(fila({ ...base, retrying: true, attemptCount: 2 }))).toMatchObject({
      cuando: `Reintento ${corta(due.toISOString())}`,
      cuandoCompleto: `Reintento ${f.dateTime(due.toISOString())}`,
      intentos: "2 intentos",
      titulo: "Hola, Sofía",
      paso: "Paso 3 · Mensaje en LinkedIn",
    });
  });

  it("un enviado lleva sus marcas (abierto, respondió) y dice cuándo salió", () => {
    const sent = new Date("2026-09-20T15:00:00Z");
    const v = vista(fila({ status: "sent", bucket: "history", reason: null, retryable: false, cancelable: false, sentAt: sent, openedAt: sent, repliedAt: sent }));
    expect(v.marcas).toEqual(["Abierto", "Respondió"]);
    expect([v.estado, v.cuando, v.cuandoCompleto]).toEqual(["Enviado", corta(sent.toISOString()), `Salió ${f.dateTime(sent.toISOString())}`]);
    expect(v.estadoKind).toBe("good");
  });

  it("un correo de la cadencia que aún no se redacta dice su paso y «por redactar», no «Sin asunto» (pulido r4)", () => {
    const borrador = { status: "draft" as const, channel: "email" as const, stepType: "email" as const, stepPosition: 2, reason: null, retryable: false };
    const v = vista(fila(borrador));
    expect(v.titulo).toBe("Paso 2 · Correo");
    expect(v.nota).toBe(MESSAGES.fila.porRedactar);
    expect(v.paso).toBeNull();
    // Con asunto ya redactado, el asunto es el título y el paso va debajo, sin nota.
    const redactado = vista(fila({ ...borrador, subject: "Una idea para Fresko" }));
    expect([redactado.titulo, redactado.paso, redactado.nota]).toEqual(["Una idea para Fresko", "Paso 2 · Correo", null]);
    // Un correo suelto (sin paso) sin asunto sigue diciendo «Sin asunto».
    const suelto = vista(fila({ ...borrador, status: "failed", stepId: null, stepType: null, stepPosition: null, sequenceName: null }));
    expect([suelto.titulo, suelto.nota]).toEqual([MESSAGES.fila.sinAsunto, null]);
  });

  it("sin nombre usa el correo; un toque suelto dice «Sin cadencia» una sola vez", () => {
    const v = vista(fila({ contactName: null, stepId: null, stepType: null, stepPosition: null, sequenceName: null }));
    expect(v.contacto).toBe("c3@marca.test");
    expect(v.contexto).toBe("Marca A · Sin cadencia");
    expect(v.paso).toBeNull();
    expect(v.titulo).toBe("Mensaje por LinkedIn");
  });

  it("un envío de otro año lleva el año en la fecha corta: el historial pagina hacia atrás sin límite", () => {
    const hace = new Date("2025-09-20T15:00:00Z");
    const v = vista(fila({ status: "sent", bucket: "history", reason: null, retryable: false, cancelable: false, sentAt: hace }));
    expect(v.cuando).toContain("2025");
    expect(vista(fila({ status: "sent", bucket: "history", reason: null, sentAt: new Date("2026-09-20T15:00:00Z") })).cuando).not.toContain("2026");
  });
});

describe("lo que espera a una persona no promete hora", () => {
  const due = new Date("2026-09-28T15:30:00Z");

  it("un retenido con hora dice que está previsto si lo apruebas, no «Sale», y lleva a revisarlo", () => {
    const v = vista(fila({ status: "held", reason: "needs_review", retryable: false, dueAt: due }), LIBRE);
    expect(v.cuando).toBe(`Previsto para ${corta(due.toISOString())} si lo apruebas`);
    expect(v.cuando).not.toMatch(/^Sale/);
    expect(v.cuandoCompleto).toBe(`Previsto para ${f.dateTime(due.toISOString())} si lo apruebas`);
    // «Revisar y aprobar» lleva a la cadencia de la ficha de su empresa, donde está el botón de verdad.
    expect(v.revisar).toBe("/ventas/empresas/00000065-0000-4000-8000-0000000000c0#cadencia");
    expect(v.motivoTono).toBe("warn");
  });

  it("un borrador sale cuando lo programas; un programado sí dice «Sale»; ninguno de los dos lleva «Revisar»", () => {
    const borrador = vista(fila({ status: "draft", reason: null, retryable: false, dueAt: due }), LIBRE);
    expect([borrador.cuando, borrador.cuandoCompleto]).toEqual([
      "Sale cuando lo programes", `Previsto para ${f.dateTime(due.toISOString())}; sale cuando lo programes`,
    ]);
    expect(vista(fila({ status: "draft", reason: null, retryable: false, dueAt: null })).cuandoCompleto).toBeNull();
    const programado = vista(fila({ status: "scheduled", reason: null, retryable: false, dueAt: due }), LIBRE);
    expect(programado.cuando).toBe(`Sale ${corta(due.toISOString())}`);
    expect([borrador.revisar, programado.revisar, borrador.espera, programado.espera]).toEqual([null, null, null, null]);
  });
});

describe("cuando la cola está parada, la fila lo dice en vez de «Sale …»", () => {
  const due = new Date("2026-09-28T15:30:00Z");
  const programado = (over: Partial<QueueRow> = {}) =>
    fila({ status: "scheduled", reason: null, retryable: false, retryBlock: null, dueAt: due, ...over });

  it("con el envío del espacio apagado: solo «En espera · envío apagado», sin repetir en cada fila la frase del aviso de arriba", () => {
    const apagado: QueueBlockers = { ...LIBRE, outreachEnabled: false };
    const v = vista(programado({ channel: "email", subject: "Hola" }), apagado);
    expect(v.cuando).toBe("En espera · envío apagado");
    expect(v.cuandoCompleto).toBe(`Estaba previsto para ${f.dateTime(due.toISOString())}`);
    // El bloqueo es del espacio entero: la frase y el enlace al interruptor están una vez, en AvisoApagado.
    expect(v.espera).toBeNull();
    // Manda sobre el canal sin cuenta: apagado, nada sale.
    expect(vista(programado({}), { ...apagado, channelsWithoutAccount: ["linkedin"] }))
      .toMatchObject({ cuando: "En espera · envío apagado", espera: null });
    // Con la cadencia además en pausa, la fila lo suma: encender el envío no la haría salir (pulido r1).
    expect(vista(programado({ sequenceStatus: "paused", enrollmentStatus: "active" }), { ...apagado, channelsWithoutAccount: ["linkedin"] }))
      .toMatchObject({ cuando: "En espera · envío apagado · cadencia en pausa", espera: { enlace: "Ir a la cadencia" } });
    // También lo retenido y el borrador (aprobarlo no lo haría salir) y un reintento recién hecho.
    expect(vista(fila({ status: "held", reason: "needs_review", retryable: false, dueAt: due }), apagado).cuando).toBe("En espera · envío apagado");
    expect(vista(fila({ status: "draft", reason: null, retryable: false }), apagado).cuando).toBe("En espera · envío apagado");
    expect(vista(programado({ retrying: true, attemptCount: 2 }), apagado).cuando).toBe("En espera · envío apagado");
    // Lo que ya terminó, lo fallido y lo que se está enviando no esperan nada.
    for (const status of ["failed", "sent", "canceled", "processing"] as const) {
      expect(vista(fila({ status, sentAt: due }), apagado).espera, status).toBeNull();
    }
  });

  it("sin ninguna cuenta del canal: «En espera · sin cuenta de LinkedIn» y el enlace a la fila de ese canal", () => {
    const sinLinkedin: QueueBlockers = { ...LIBRE, channelsWithoutAccount: ["linkedin"] };
    const v = vista(programado(), sinLinkedin);
    expect(v.cuando).toBe("En espera · sin cuenta de LinkedIn");
    expect(v.espera?.href).toBe("/ventas/canales#canal-linkedin-titulo");
    expect(v.espera?.texto).toBe("No hay ninguna cuenta de LinkedIn conectada: sale en cuanto conectes una.");
    // Un correo del mismo espacio sí sale.
    expect(vista(programado({ channel: "email", subject: "Hola" }), sinLinkedin).cuando).toBe(`Sale ${corta(due.toISOString())}`);
  });

  it("con la cadencia en pausa: «En espera · cadencia en pausa» y el enlace a la cadencia, no «Sale mañana»", () => {
    const v = vista(programado({ sequenceStatus: "paused", enrollmentStatus: "active" }), LIBRE);
    expect(v.cuando).toBe("En espera · cadencia en pausa");
    expect(v.cuando).not.toMatch(/\bSale\b/);
    expect(v.espera).toEqual({
      texto: "La cadencia está en pausa: no sale nada de ella hasta que la reanudes.",
      enlace: "Ir a la cadencia",
      href: "/ventas/cadencias/00000065-0000-4000-8000-00000000005e",
    });
    // Sin conexión con el estado de la cola: también sin bloqueos leídos, y en lo retenido y el borrador.
    expect(vista(programado({ sequenceStatus: "paused", enrollmentStatus: "active" })).cuando).toBe("En espera · cadencia en pausa");
    expect(vista(fila({ status: "held", reason: "needs_review", retryable: false, dueAt: due, sequenceStatus: "paused", enrollmentStatus: "active" }), LIBRE)
      .cuando).toBe("En espera · cadencia en pausa");
    // Va antes que el canal: reconectar LinkedIn no la haría salir.
    expect(vista(programado({ sequenceStatus: "paused", enrollmentStatus: "active" }), { ...LIBRE, channelsWithoutAccount: ["linkedin"] }).cuando)
      .toBe("En espera · cadencia en pausa");
  });

  it("con esta persona en pausa o tras un «ahora no»: lo dice y lleva a su cadencia en la ficha", () => {
    const pausada = vista(programado({ enrollmentStatus: "paused" }), LIBRE);
    expect(pausada.cuando).toBe("En espera · en pausa para esta persona");
    expect(pausada.espera?.href).toBe("/ventas/empresas/00000065-0000-4000-8000-0000000000c0#cadencia");
    const ahoraNo = vista(programado({ enrollmentStatus: "cooldown" }), LIBRE);
    expect(ahoraNo.cuando).toBe("En espera · dijo «ahora no»");
    expect(ahoraNo.espera?.texto).toContain("no sale mientras tanto");
    // Una cadencia activa, un toque suelto (sin inscripción) o una archivada (el despachador lo cancela) no esperan por esto.
    expect(vista(programado({ enrollmentStatus: "active" }), LIBRE).cuando).toBe(`Sale ${corta(due.toISOString())}`);
    expect(vista(programado({ enrollmentStatus: null, sequenceStatus: null, sequenceId: null }), LIBRE).espera).toBeNull();
    expect(vista(programado({ enrollmentStatus: "active", sequenceStatus: "archived" }), LIBRE).espera).toBeNull();
  });

  it("con el canal fuera de la política: lo dice y lleva a la política", () => {
    const v = vista(programado({ channel: "instagram_dm" }), { ...LIBRE, channelsNotAllowed: ["instagram_dm"], channelsWithoutAccount: ["instagram_dm"] });
    expect(v.cuando).toBe("En espera · Instagram no está permitido");
    expect(v.espera?.href).toBe("/ventas/politica");
  });
});
