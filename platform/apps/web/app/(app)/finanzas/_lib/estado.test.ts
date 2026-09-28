import { describe, expect, it } from "vitest";
import {
  RECEIVABLE_FILTERS,
  RECEIVABLE_FILTER_KEYS,
  filterKey,
  invoiceFilterHref,
  pillForInvoice,
  pillForReceivable,
  receivableFilterKey,
  receivableHref,
} from "./estado";

describe("la pastilla de mora", () => {
  it("una vencida sale en rojo y dice desde cuándo, con la misma frase que el mock", () => {
    expect(pillForReceivable({ bucket: "vencida", daysOverdue: 41, status: "sent" })).toEqual({
      kind: "bad",
      text: "Vencida hace 41 días",
    });
  });

  it("ayer y hoy se dicen con palabras, no con «hace 1 días» ni «en 0 días»", () => {
    expect(pillForReceivable({ bucket: "vencida", daysOverdue: 1, status: "sent" }).text).toBe("Vencida ayer");
    expect(pillForReceivable({ bucket: "vence_pronto", daysOverdue: 0, status: "sent" }).text).toBe("Vence hoy");
    expect(pillForReceivable({ bucket: "vence_pronto", daysOverdue: -1, status: "sent" }).text).toBe("Vence mañana");
  });

  it("vence pronto en ámbar, al día en verde y cobrada en neutral", () => {
    expect(pillForReceivable({ bucket: "vence_pronto", daysOverdue: -7, status: "sent" })).toEqual({
      kind: "warn",
      text: "Vence en 7 días",
    });
    expect(pillForReceivable({ bucket: "al_dia", daysOverdue: -23, status: "sent" })).toEqual({
      kind: "good",
      text: "Al día",
    });
    expect(pillForReceivable({ bucket: "pagada", daysOverdue: 5, status: "paid" })).toEqual({
      kind: "neutral",
      text: "Cobrada",
    });
  });

  it("un abono parcial se antepone sin perder el color de la mora", () => {
    const p = pillForReceivable({ bucket: "vencida", daysOverdue: 41, status: "partial" });
    expect(p.kind).toBe("bad");
    expect(p.text).toBe("Pago parcial · Vencida hace 41 días");
  });

  it("las dos vistas del módulo llaman igual a la misma factura", () => {
    // daysToDue son los días que FALTAN; daysOverdue, los de mora.
    expect(pillForInvoice({ bucket: "vencida", daysToDue: -41, status: "sent" })).toEqual(
      pillForReceivable({ bucket: "vencida", daysOverdue: 41, status: "sent" }),
    );
  });

  it("el archivo tiene además borrador y anulada, que la vista receivables excluye", () => {
    expect(pillForInvoice({ bucket: "borrador", daysToDue: 30, status: "draft" }).text).toBe("Borrador");
    expect(pillForInvoice({ bucket: "anulada", daysToDue: 30, status: "void" }).text).toBe("Anulada");
  });
});

describe("el filtro vive en la URL", () => {
  it("«Por cobrar» es el defecto y no ensucia la URL", () => {
    expect(receivableFilterKey(undefined)).toBe("por_cobrar");
    expect(receivableFilterKey("no-existe")).toBe("por_cobrar");
    expect(receivableHref("por_cobrar")).toBe("/finanzas");
    expect(RECEIVABLE_FILTERS.por_cobrar.bucket).toBe(null);
  });

  it("una propiedad heredada de Object no es un filtro (hallazgo de /code-review)", () => {
    // Con `in` en vez de Object.hasOwn, ?bucket=toString pasaba por
    // bueno y la pantalla decía «No hay facturas en «undefined»».
    for (const heredada of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(receivableFilterKey(heredada)).toBe("por_cobrar");
      expect(RECEIVABLE_FILTERS[receivableFilterKey(heredada)].label).toBe("Por cobrar");
    }
    expect(filterKey("toString")).toBe("todas");
  });

  it("cada bucket tiene su URL compartible y conserva la búsqueda", () => {
    expect(receivableFilterKey("vencida")).toBe("vencida");
    expect(receivableHref("vencida")).toBe("/finanzas?bucket=vencida");
    expect(receivableHref("vencida", "Hogar")).toBe("/finanzas?bucket=vencida&q=Hogar");
    expect(receivableHref("por_cobrar", "Hogar")).toBe("/finanzas?q=Hogar");
  });

  it("los buckets del filtro son los de la vista: ni borrador ni anulada", () => {
    expect(RECEIVABLE_FILTER_KEYS).toEqual(["por_cobrar", "vencida", "vence_pronto", "al_dia", "pagada"]);
    for (const key of RECEIVABLE_FILTER_KEYS) {
      const bucket = RECEIVABLE_FILTERS[key].bucket;
      expect(bucket === null || ["vencida", "vence_pronto", "al_dia", "pagada"].includes(bucket)).toBe(true);
    }
  });

  it("el archivo de facturas tiene su propio parámetro y su propia ruta", () => {
    expect(invoiceFilterHref("todas")).toBe("/finanzas/facturas");
    expect(invoiceFilterHref("borradores")).toBe("/finanzas/facturas?estado=borradores");
  });
});
