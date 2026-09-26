import { describe, expect, it } from "vitest";
import { retryScheduledFor, type QueueRow } from "@mc/db/queries/actividad";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { filaVista } from "./filas";
import { codigoDeMotivo, filtrosDe, hayFiltros, hrefDe, motivoDe, resumenDe } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

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
    expect(motivoDe("held", "placeholders:{{first_name}}", "es-CO")).toMatch(/^[A-ZÁÉÍÓÚ]/);
    expect(motivoDe("held", "placeholders:{{first_name}}", "es-CO")).toContain("{{first_name}}");
  });

  it("un fallido dice qué pasó con el proveedor; un cancelado, por qué no salió", () => {
    expect(motivoDe("failed", "max_attempts", "es-CO")).toBe("Fallaron los cinco intentos");
    expect(motivoDe("canceled", "canceled_by_user", "es-CO")).toBe("Lo cancelaste desde la actividad");
    expect(motivoDe("canceled", "replied", "es-CO")).toBe("Respondió y la cadencia se detuvo");
    expect(motivoDe("failed", "max_attempts", "en-US")).toBe("All five attempts failed");
  });

  it("un código desconocido no se enseña crudo en la fila, pero sí en el detalle (para soporte)", () => {
    expect(motivoDe("canceled", "algo_raro", "es-CO")).toBe("No salió");
    expect(codigoDeMotivo("algo_raro")).toBe("código: algo_raro");
    expect(motivoDe("scheduled", null, "es-CO")).toBeNull();
    // Un nombre de propiedad de Object no es un motivo.
    expect(motivoDe("canceled", "toString", "es-CO")).toBe("No salió");
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
    const v = filaVista(fila(), f);
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
    expect(v.cuando).toBe(f.dateTimeShort("2026-09-23T15:30:00Z"));
    expect(v.queEs).toBe("Paso 3 · Mensaje en LinkedIn");
    expect(v.cuandoCompleto).toBe(`Falló ${f.dateTime("2026-09-23T15:30:00Z")}`);
    expect(v.cuando).not.toContain("2026");
    expect(v.fichaHref).toBe("/ventas/empresas/00000065-0000-4000-8000-0000000000c0");
  });

  it("un fallido bloqueado dice por qué, con la frase del resumen; uno de la cuenta caída lleva a reconectar", () => {
    const rebote = filaVista(fila({ reason: "bounced", retryBlock: "not_retryable", retryable: false }), f);
    expect([rebote.reintentable, rebote.bloqueo, rebote.reconectar]).toEqual([false, "No se reintenta: rebotó o pudo haber salido.", null]);
    const lleno = filaVista(fila({ attemptCount: 19, retryBlock: "too_many_attempts", retryable: false }), f);
    expect(lleno.bloqueo).toBe("No se reintenta: ya gastó todos sus intentos.");
    const caida = filaVista(fila({ reason: "account_auth", retryBlock: "account_down", retryable: false, accountStatus: "needs_reconnect" }), f);
    // Lleva a la fila de su canal en /ventas/canales, donde está el botón de reconectar.
    expect([caida.reintentable, caida.bloqueo, caida.reconectar]).toEqual([false, null, "/ventas/canales#canal-linkedin-titulo"]);
    expect(caida.motivoCodigo).toBe("código: account_auth");
  });

  it("lo que ya no sale: la pastilla dice el verbo, al lado solo la fecha, y la frase entera en la larga; lo que se envía, desde cuándo", () => {
    const at = "2026-09-23T15:30:00Z";
    const base = { reason: null, retryable: false };
    const cancelado = filaVista(fila({ ...base, status: "canceled", bucket: "history" }), f);
    expect([cancelado.estado, cancelado.cuando, cancelado.cuandoCompleto]).toEqual(["Cancelado", f.dateTimeShort(at), `Se canceló ${f.dateTime(at)}`]);
    const saltado = filaVista(fila({ ...base, status: "skipped", bucket: "history" }), f);
    expect([saltado.cuando, saltado.cuandoCompleto]).toEqual([f.dateTimeShort(at), `Se saltó ${f.dateTime(at)}`]);
    const enviando = filaVista(fila({ ...base, status: "processing" }), f);
    expect([enviando.estado, enviando.cuando, enviando.cuandoCompleto]).toEqual([
      "Enviando", `Desde ${f.dateTimeShort(at)}`, `Enviándose desde ${f.dateTime(at)}`,
    ]);
  });

  it("un reintento hecho fuera de horario dice la hora a la que sale de verdad, no la del clic", () => {
    // retryFailedTouches deja scheduled_for en la apertura de la ventana (retryScheduledFor): un viernes a las 20:00 de
    // Bogotá, el lunes a las 08:12. La fila dice esa hora, en la zona del espacio.
    const viernes = new Date("2026-09-26T01:00:00Z");
    const lunes = retryScheduledFor("00000065-0000-4000-8000-0000000000f1", viernes, "America/Bogota", { start: "08:00", end: "18:00" });
    const v = filaVista(fila({ status: "scheduled", reason: null, retryable: false, retryBlock: null, dueAt: lunes }), f);
    expect(v.cuando).toBe(`Sale ${f.dateTimeShort(lunes.toISOString())}`);
    expect(v.cuandoCompleto).toMatch(/^Sale 28 de septiembre de 2026 a las 8:[0-2]\d a\. m\.$/);
  });

  it("un correo programado dice cuándo sale; uno que se reintenta, cuándo es el reintento", () => {
    const due = new Date("2026-09-26T15:30:00Z");
    const base = { status: "scheduled" as const, channel: "email" as const, subject: "Hola, Sofía", reason: null, retryable: false, dueAt: due };
    expect(filaVista(fila(base), f).cuando).toBe(`Sale ${f.dateTimeShort(due.toISOString())}`);
    expect(filaVista(fila({ ...base, retrying: true, attemptCount: 2 }), f)).toMatchObject({
      cuando: `Reintento ${f.dateTimeShort(due.toISOString())}`,
      cuandoCompleto: `Reintento ${f.dateTime(due.toISOString())}`,
      intentos: "2 intentos",
      titulo: "Hola, Sofía",
      paso: "Paso 3 · Mensaje en LinkedIn",
    });
  });

  it("un enviado lleva sus marcas (abierto, respondió) y dice cuándo salió", () => {
    const sent = new Date("2026-09-20T15:00:00Z");
    const v = filaVista(
      fila({ status: "sent", bucket: "history", reason: null, retryable: false, cancelable: false, sentAt: sent, openedAt: sent, repliedAt: sent }),
      f,
    );
    expect(v.marcas).toEqual(["Abierto", "Respondió"]);
    expect([v.estado, v.cuando, v.cuandoCompleto]).toEqual(["Enviado", f.dateTimeShort(sent.toISOString()), `Salió ${f.dateTime(sent.toISOString())}`]);
    expect(v.estadoKind).toBe("good");
  });

  it("sin nombre usa el correo; un toque suelto dice «Sin cadencia» una sola vez", () => {
    const v = filaVista(fila({ contactName: null, stepId: null, stepType: null, stepPosition: null, sequenceName: null }), f);
    expect(v.contacto).toBe("c3@marca.test");
    expect(v.contexto).toBe("Marca A · Sin cadencia");
    expect(v.paso).toBeNull();
    expect(v.titulo).toBe("Mensaje por LinkedIn");
  });
});
