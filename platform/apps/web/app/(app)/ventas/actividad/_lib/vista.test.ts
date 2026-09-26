import { describe, expect, it } from "vitest";
import type { QueueRow } from "@mc/db/queries/actividad";
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
  it("el fallido: paso, a quién, cuándo falló (corto, con su verbo), intentos, cuenta y su motivo con el código", () => {
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
    expect([v.reintentable, v.bloqueo, v.reconectar]).toEqual([true, null, false]);
    expect(v.cuando).toBe(`Falló ${f.dateTimeShort("2026-09-23T15:30:00Z")}`);
    expect(v.cuandoCompleto).toBe(`Falló ${f.dateTime("2026-09-23T15:30:00Z")}`);
    expect(v.cuando).not.toContain("2026");
    expect(v.fichaHref).toBe("/ventas/empresas/00000065-0000-4000-8000-0000000000c0");
  });

  it("un fallido bloqueado dice por qué, con la frase del resumen; uno de la cuenta caída lleva a reconectar", () => {
    const rebote = filaVista(fila({ reason: "bounced", retryBlock: "not_retryable", retryable: false }), f);
    expect([rebote.reintentable, rebote.bloqueo, rebote.reconectar]).toEqual([false, "No se reintenta: rebotó o pudo haber salido.", false]);
    const lleno = filaVista(fila({ attemptCount: 19, retryBlock: "too_many_attempts", retryable: false }), f);
    expect(lleno.bloqueo).toBe("No se reintenta: ya gastó todos sus intentos.");
    const caida = filaVista(fila({ reason: "account_auth", retryBlock: "account_down", retryable: false, accountStatus: "needs_reconnect" }), f);
    expect([caida.reintentable, caida.bloqueo, caida.reconectar]).toEqual([false, null, true]);
    expect(caida.motivoCodigo).toBe("código: account_auth");
  });

  it("cada estado que ya no sale dice su verbo; lo que se envía, desde cuándo", () => {
    const at = "2026-09-23T15:30:00Z";
    const base = { reason: null, retryable: false };
    expect(filaVista(fila({ ...base, status: "canceled", bucket: "history" }), f).cuando).toBe(`Se canceló ${f.dateTimeShort(at)}`);
    expect(filaVista(fila({ ...base, status: "skipped", bucket: "history" }), f).cuando).toBe(`Se saltó ${f.dateTimeShort(at)}`);
    expect(filaVista(fila({ ...base, status: "processing" }), f).cuando).toBe(`Enviándose desde ${f.dateTimeShort(at)}`);
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
    expect(v.cuando).toBe(`Salió ${f.dateTimeShort(sent.toISOString())}`);
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
