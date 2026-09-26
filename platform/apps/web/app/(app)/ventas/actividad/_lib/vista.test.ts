import { describe, expect, it } from "vitest";
import type { QueueRow } from "@mc/db/queries/actividad";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { filaVista } from "./filas";
import { detalleDeMotivo, filtrosDe, hayFiltros, hrefDe, motivoDe, resumenDe } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

const fila = (over: Partial<QueueRow> = {}): QueueRow => ({
  touchId: "00000064-0000-4000-8000-000000000733",
  status: "failed",
  bucket: "queue",
  channel: "linkedin",
  subject: null,
  sequenceId: "00000064-0000-4000-8000-00000000005e",
  sequenceName: "Semana de prueba",
  stepId: "00000064-0000-4000-8000-000000005e03",
  stepType: "linkedin_message",
  stepPosition: 3,
  stepDayOffset: 4,
  enrollmentStatus: "completed",
  contactId: "00000064-0000-4000-8000-0000000000d3",
  contactName: "Persona 3",
  contactEmail: "c3@marca.test",
  companyId: "00000064-0000-4000-8000-0000000000c0",
  companyName: "Marca A",
  accountName: "Laura Méndez",
  attemptCount: 5,
  dueAt: null,
  retrying: false,
  statusChangedAt: new Date("2026-09-23T15:30:00Z"),
  sentAt: null,
  openedAt: null,
  repliedAt: null,
  reason: "max_attempts",
  retryable: true,
  cancelable: true,
  ...over,
});

describe("los filtros de la URL", () => {
  it("leen la pestaña y los tres filtros, y vuelven a la misma URL", () => {
    const filtros = filtrosDe({ vista: "historial", cadencia: "abc", tipo: "email", contacto: " sofía " });
    expect(filtros).toEqual({ vista: "history", cadencia: "abc", tipo: "email", contacto: "sofía" });
    expect(hrefDe(filtros)).toBe("/ventas/actividad?vista=historial&cadencia=abc&tipo=email&contacto=sof%C3%ADa");
    expect(hayFiltros(filtros)).toBe(true);
  });

  it("sin nada, la cola y la URL desnuda; lo desconocido se ignora", () => {
    const filtros = filtrosDe({ vista: "otra", contacto: "   " });
    expect(filtros).toEqual({ vista: "queue", cadencia: null, tipo: null, contacto: null });
    expect(hrefDe(filtros)).toBe("/ventas/actividad");
    expect(hayFiltros(filtros)).toBe(false);
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
    expect(detalleDeMotivo("canceled", "algo_raro", "es-CO")).toBe("No salió (código: algo_raro)");
    expect(motivoDe("scheduled", null, "es-CO")).toBeNull();
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
  it("el fallido: paso, a quién, cuándo falló, intentos y su motivo con el código en el detalle", () => {
    const v = filaVista(fila(), f);
    expect(v.estado).toBe("Falló");
    expect(v.estadoKind).toBe("bad");
    expect(v.titulo).toBe("Paso 3 · Mensaje en LinkedIn");
    expect(v.contacto).toBe("Persona 3");
    expect(v.contexto).toBe("Marca A · Semana de prueba");
    expect(v.intentos).toBe("5 intentos");
    expect(v.motivo).toBe("Fallaron los cinco intentos");
    expect(v.motivoDetalle).toBe("Fallaron los cinco intentos (código: max_attempts)");
    expect(v.motivoTono).toBe("bad");
    expect(v.reintentable).toBe(true);
    expect(v.noReintentable).toBe(false);
    expect(v.cuando).toBe(f.dateTime("2026-09-23T15:30:00Z"));
    expect(v.fichaHref).toBe("/ventas/empresas/00000064-0000-4000-8000-0000000000c0");
  });

  it("un rebote no se ofrece para reintentar; dice por qué", () => {
    const v = filaVista(fila({ reason: "bounced", retryable: false }), f);
    expect([v.reintentable, v.noReintentable]).toEqual([false, true]);
  });

  it("un correo programado dice cuándo sale; uno que se reintenta, cuándo es el reintento", () => {
    const due = new Date("2026-09-26T15:30:00Z");
    const base = { status: "scheduled" as const, channel: "email", subject: "Hola, Sofía", reason: null, retryable: false, dueAt: due };
    expect(filaVista(fila(base), f).cuando).toBe(`Sale ${f.dateTime(due.toISOString())}`);
    expect(filaVista(fila({ ...base, retrying: true, attemptCount: 2 }), f)).toMatchObject({
      cuando: `Reintento ${f.dateTime(due.toISOString())}`,
      intentos: "2 intentos",
      titulo: "Hola, Sofía",
    });
  });

  it("un enviado lleva sus marcas (abierto, respondió) y dice cuándo salió", () => {
    const sent = new Date("2026-09-20T15:00:00Z");
    const v = filaVista(
      fila({ status: "sent", bucket: "history", reason: null, retryable: false, cancelable: false, sentAt: sent, openedAt: sent, repliedAt: sent }),
      f,
    );
    expect(v.marcas).toEqual(["Abierto", "Respondió"]);
    expect(v.cuando).toBe(`Salió ${f.dateTime(sent.toISOString())}`);
    expect(v.estadoKind).toBe("good");
  });

  it("sin nombre usa el correo; sin paso lo dice", () => {
    const v = filaVista(fila({ contactName: null, stepId: null, stepType: null, stepPosition: null, sequenceName: null }), f);
    expect(v.contacto).toBe("c3@marca.test");
    expect(v.paso).toBe("Fuera de una cadencia");
    expect(v.contexto).toBe("Marca A · Sin cadencia");
  });
});
