import { describe, expect, it } from "vitest";
import { CONTACT_SOURCES, RELATIONSHIPS, SIGNAL_STATUSES } from "@mc/db/queries/ventas";
import {
  RELATIONSHIP_META,
  RELATIONSHIP_OPTIONS,
  SIGNAL_STATUS_META,
  SOURCE_META,
  SOURCE_OPTIONS,
  MODULE_LINKS,
  TABS,
  applyMove,
  fitFromPercent,
  fitPercent,
  pipelineForma,
  needsNextAction,
  pillForDue,
  pillForFit,
  tabHref,
  tabKey,
} from "./estado";

describe("pestañas", () => {
  it("la vista vive en la URL y el radar es la de por defecto", () => {
    expect(tabKey(undefined)).toBe("radar");
    expect(tabKey("pipeline")).toBe("pipeline");
    expect(tabHref("radar")).toBe("/ventas");
    expect(tabHref("pipeline")).toBe("/ventas?vista=pipeline");
  });

  it("un valor desconocido en la URL cae en el radar, sin romper", () => {
    expect(tabKey("facturas")).toBe("radar");
    expect(tabKey("__proto__")).toBe("radar");
    expect(tabKey("constructor")).toBe("radar");
  });
});

describe("etiquetas de la base", () => {
  it("toda relación de company_link tiene etiqueta en español y color", () => {
    for (const r of RELATIONSHIPS) {
      expect(RELATIONSHIP_META[r], `falta la relación ${r}`).toBeDefined();
      expect(RELATIONSHIP_META[r].label).not.toBe("");
    }
    // Y el selector las ofrece todas: si mañana la base añade una, la
    // pantalla no puede quedarse sin poder elegirla.
    expect(RELATIONSHIP_OPTIONS.map((o) => o.value).sort()).toEqual([...RELATIONSHIPS].sort());
  });

  it("toda procedencia de contacto tiene etiqueta y una ayuda que dice cuándo usarla", () => {
    for (const s of CONTACT_SOURCES) {
      expect(SOURCE_META[s], `falta la fuente ${s}`).toBeDefined();
      expect(SOURCE_META[s].help.length).toBeGreaterThan(10);
    }
    expect(SOURCE_OPTIONS.map((o) => o.value).sort()).toEqual([...CONTACT_SOURCES].sort());
  });

  it("todo estado de señal tiene su pastilla", () => {
    for (const s of SIGNAL_STATUSES) {
      expect(SIGNAL_STATUS_META[s], `falta el estado ${s}`).toBeDefined();
    }
  });

  it("solo el radar y el pipeline viajan en la URL; Empresas es su propia ruta", () => {
    expect(TABS).toEqual(["radar", "pipeline"]);
    expect(tabKey("empresas")).toBe("radar");
    expect(MODULE_LINKS.map((l) => l.href)).toEqual(["/ventas", "/ventas?vista=pipeline", "/ventas/empresas"]);
  });
});

describe("seguimiento", () => {
  it("vencido es rojo, hoy es ámbar y al día no llama la atención", () => {
    expect(pillForDue("vencido")).toEqual({ kind: "bad", text: "Vencido" });
    expect(pillForDue("hoy")).toEqual({ kind: "warn", text: "Hoy" });
    expect(pillForDue("futuro")).toEqual({ kind: "neutral", text: "Al día" });
  });

  it("«sin fecha» avisa: es el problema que la pantalla existe para señalar", () => {
    expect(pillForDue("sin_fecha").kind).toBe("warn");
  });

  it("solo se marca un negocio abierto sin siguiente acción", () => {
    expect(needsNextAction({ nextAction: null, isWon: false, isLost: false })).toBe(true);
    expect(needsNextAction({ nextAction: "Llamar", isWon: false, isLost: false })).toBe(false);
    // A un negocio ganado no le falta nada.
    expect(needsNextAction({ nextAction: null, isWon: true, isLost: false })).toBe(false);
    expect(needsNextAction({ nextAction: null, isWon: false, isLost: true })).toBe(false);
  });
});

describe("encaje", () => {
  it("el decimal de la base se pinta como porcentaje entero", () => {
    expect(fitPercent("0.8500")).toBe(85);
    expect(fitPercent("0.7150")).toBe(72);
    expect(fitPercent("1.0000")).toBe(100);
    expect(fitPercent("0")).toBe(0);
  });

  it("sin encaje no se inventa un cero", () => {
    expect(fitPercent(null)).toBeNull();
    expect(pillForFit(null)).toBeNull();
  });

  it("un valor que no es número no se pinta", () => {
    expect(fitPercent("no-es-un-numero")).toBeNull();
  });

  it("el color del encaje cambia en 75 y en 50", () => {
    expect(pillForFit("0.7500")).toEqual({ kind: "good", text: "75 %" });
    expect(pillForFit("0.7400")).toEqual({ kind: "warn", text: "74 %" });
    expect(pillForFit("0.5000")).toEqual({ kind: "warn", text: "50 %" });
    expect(pillForFit("0.4900")).toEqual({ kind: "neutral", text: "49 %" });
  });
});

describe("fitFromPercent", () => {
  it("pasa el porcentaje a la fracción que guarda la base", () => {
    expect(fitFromPercent("80")).toBe("0.80");
    expect(fitFromPercent("7,4")).toBe("0.07");
    expect(fitFromPercent("100")).toBe("1.00");
    expect(fitFromPercent(" ")).toBeNull();
  });
  it("rechaza lo que no es un porcentaje", () => {
    expect(fitFromPercent("120")).toBeUndefined();
    expect(fitFromPercent("-3")).toBeUndefined();
    expect(fitFromPercent("alto")).toBeUndefined();
  });
});

describe("pipelineForma", () => {
  it("el tablero es la de por defecto", () => {
    expect(pipelineForma(undefined)).toBe("tablero");
    expect(pipelineForma("lista")).toBe("lista");
    expect(pipelineForma("__proto__")).toBe("tablero");
  });
});

describe("applyMove", () => {
  const deals = [
    { id: "a", stageId: "nuevo", stageLabel: "Nuevo", daysInStage: 4 },
    { id: "b", stageId: "nuevo", stageLabel: "Nuevo", daysInStage: 2 },
  ];
  it("mueve solo ese negocio y le reinicia los días en la etapa", () => {
    const out = applyMove(deals, { dealId: "a", toStageId: "ganado", toStageLabel: "Ganado" });
    expect(out[0]).toEqual({ id: "a", stageId: "ganado", stageLabel: "Ganado", daysInStage: 0 });
    expect(out[1]).toBe(deals[1]);
  });
  it("soltarlo en su misma columna no cambia nada", () => {
    const out = applyMove(deals, { dealId: "a", toStageId: "nuevo", toStageLabel: "Nuevo" });
    expect(out[0]).toBe(deals[0]);
  });
});
