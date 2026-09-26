import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefCreator, HiddenSignals, OutboundBrief } from "@mc/db/queries/brief";

/**
 * Lo que decide la PÁGINA del brief (VEN-7): de quién es, si está
 * activo, cuántas señales deja fuera hoy y qué valores le pasa al
 * formulario. El formulario tiene su prueba en form.test.tsx y las
 * consultas en packages/db/test/brief.test.ts.
 */
const LAURA: BriefCreator = { id: "c1", displayName: "Laura Gómez", briefStatus: null, briefTitle: null };
const estado = vi.hoisted(() => ({
  briefs: {} as Record<string, OutboundBrief>,
  creators: [] as BriefCreator[],
  kind: "creator" as "creator" | "agency",
  editable: true,
  hidden: { total: 0, byCompany: 0, byCategory: 0 } as HiddenSignals,
  pedido: [] as string[],
}));
const formProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@mc/db/queries/brief", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/brief")>()),
  getBrief: async (_tx: unknown, creatorId: string) => {
    estado.pedido.push(creatorId);
    return estado.briefs[creatorId] ?? null;
  },
  listBriefCreators: async () => ({ workspaceKind: estado.kind, creators: estado.creators }),
  listCategorySuggestions: async () => ["alimentos"],
  listBriefCompanyOptions: async () => [{ id: "e1", name: "Café Alma" }],
  countHiddenSignals: async () => estado.hidden,
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
vi.mock("./permiso", () => ({ puedeEditarElBrief: async () => estado.editable }));
vi.mock("./form", () => ({
  BriefForm: (props: Record<string, unknown>) => {
    formProps.last = props;
    return <div data-testid="formulario" />;
  },
}));

import { MESSAGES } from "../_lib/messages";
import BriefPage from "./page";

const t = MESSAGES.brief;

const BRIEF: OutboundBrief = {
  id: "b1",
  creatorId: "c1",
  creatorName: "Laura Gómez",
  title: "Marcas de alimentos y cocina · Q4 2026",
  wantedCategories: ["alimentos", "cocina"],
  wantedCountries: ["CO", "MX"],
  minBudget: "3000000.00",
  currency: "COP",
  deliverables: ["tiktok", "reel", "podcast"],
  availabilityFrom: "2026-10-01",
  availabilityTo: "2026-12-15",
  excludedCategories: ["alcohol"],
  excludedCompanies: [{ id: "e1", name: "Café Alma" }],
  requiresDisclosure: true,
  notes: null,
  status: "active",
  updatedAt: "2026-09-24T15:00:00.000Z",
};

/** La página con sus searchParams, como la llama Next. */
async function pagina(creador?: string) {
  return BriefPage({ searchParams: Promise.resolve(creador ? { creador } : {}) });
}

beforeEach(() => {
  estado.briefs = {};
  estado.creators = [LAURA];
  estado.kind = "creator";
  estado.pedido = [];
  estado.editable = true;
  estado.hidden = { total: 0, byCompany: 0, byCategory: 0 };
  formProps.last = null;
});

describe("la página del brief", () => {
  it("sin brief, ofrece uno activo con un nombre para empezar y dice que todavía no hay", async () => {
    render(await pagina());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(t.title);
    expect(screen.getByText(t.of("Laura Gómez"))).toBeInTheDocument();
    expect(screen.getByText(t.none)).toBeInTheDocument();
    const values = formProps.last?.values as { title: string; active: boolean; currency: string; creatorId: string };
    expect(values).toMatchObject({ title: t.defaultTitle, active: true, currency: "COP", creatorId: "c1" });
    expect(screen.queryByRole("form", { name: t.creator.label })).toBeNull();
  });

  it("con brief, dice su estado y cuántas señales deja fuera, con el enlace a verlas", async () => {
    estado.briefs = { c1: BRIEF };
    estado.creators = [{ ...LAURA, briefStatus: "active" }];
    estado.hidden = { total: 3, byCompany: 1, byCategory: 2 };
    render(await pagina());
    expect(screen.getByText(t.status.active)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t.hidingNow("3", 3));
    expect(screen.getByRole("link", { name: t.seeHidden })).toHaveAttribute("href", "/ventas?ocultas=1");

    const props = formProps.last as {
      values: { wantedCountries: { value: string; label: string }[]; excludedCompanies: unknown[] };
      deliverableOptions: { value: string; label: string }[];
    };
    expect(props.values.wantedCountries).toEqual([
      { value: "CO", label: "Colombia" },
      { value: "MX", label: "México" },
    ]);
    expect(props.values.excludedCompanies).toEqual([{ value: "e1", label: "Café Alma" }]);
    // Un formato guardado que no es del catálogo sigue a la vista, con su nombre tal cual.
    expect(props.deliverableOptions).toContainEqual({ value: "podcast", label: "podcast" });
  });

  it("sin creador en el espacio no ofrece un formulario que no podría guardar", async () => {
    estado.creators = [];
    render(await pagina());
    expect(screen.getByText(t.noCreator.title)).toBeInTheDocument();
    expect(screen.queryByTestId("formulario")).toBeNull();
  });

  it("en una agencia elige creador: el brief es de uno, y dice cómo se combina con los demás (VEN-7 r3)", async () => {
    const BETO: BriefCreator = { id: "c2", displayName: "Beto Ruiz", briefStatus: null, briefTitle: null };
    estado.kind = "agency";
    estado.creators = [{ ...LAURA, briefStatus: "active" }, BETO];
    estado.briefs = { c1: BRIEF };
    estado.hidden = { total: 2, byCompany: 0, byCategory: 2 };

    // Sin ?creador, el primero con brief activo.
    const { unmount } = render(await pagina());
    expect(screen.getByText(t.of("Laura Gómez"))).toBeInTheDocument();
    const selector = screen.getByRole("form", { name: t.creator.label });
    expect(within(selector).getByRole("combobox")).toHaveValue("c1");
    expect(within(selector).getAllByRole("option").map((o) => o.textContent)).toEqual([
      t.creator.option("Laura Gómez", t.status.active),
      t.creator.option("Beto Ruiz", null),
    ]);
    // Beto no tiene brief activo: no hay «otros» que avisar, pero sí la regla de las cadencias.
    expect(screen.getByRole("note")).toHaveTextContent(t.cadencesRule);
    unmount();

    // Con ?creador=c2, el de Beto: vacío, y guardarlo es guardar el SUYO.
    render(await pagina("c2"));
    expect(screen.getByText(t.of("Beto Ruiz"))).toBeInTheDocument();
    expect(screen.getByText(t.none)).toBeInTheDocument();
    expect(estado.pedido.at(-1)).toBe("c2");
    expect((formProps.last?.values as { creatorId: string }).creatorId).toBe("c2");
    // Laura sí tiene brief activo: el radar oculta solo lo que excluyen los dos.
    expect(screen.getByRole("note")).toHaveTextContent(t.others("Laura Gómez", 1));
    expect(screen.getByRole("status")).toHaveTextContent(t.hidingNowAll("2", 2));
    expect(screen.queryByText("Brief del espacio")).toBeNull();
  });

  it("un ?creador que no es del espacio no abre el brief de nadie más: vuelve al principal", async () => {
    render(await pagina("00000000-0000-4000-8000-000000000000"));
    expect(estado.pedido).toEqual(["c1"]);
  });

  it("la moneda del mínimo es la del workspace si el brief no tiene mínimo, y la del brief si lo tiene", async () => {
    estado.briefs = { c1: { ...BRIEF, minBudget: null, currency: "USD" } };
    const { unmount } = render(await pagina());
    expect((formProps.last?.values as { currency: string }).currency).toBe("COP");
    unmount();
    estado.briefs = { c1: { ...BRIEF, currency: "USD" } };
    render(await pagina());
    expect((formProps.last?.values as { currency: string }).currency).toBe("USD");
    const monedas = formProps.last?.currencies as { value: string }[];
    expect(monedas.slice(0, 2).map((m) => m.value)).toEqual(["COP", "USD"]);
  });

  it("a quien no es owner ni admin le pasa el formulario de solo lectura", async () => {
    estado.editable = false;
    render(await pagina());
    expect(formProps.last?.editable).toBe(false);
  });

  it("el texto no promete lo que no se cumple: ni «pitch», ni que «Qué buscas» filtre", () => {
    const textos = [t.description, t.wants.help, t.rejects.help, t.fields.notesHelp, t.state.help].join(" ");
    expect(textos).not.toMatch(/pitch/i);
    expect(t.wants.help).toMatch(/no oculta ninguna señal/);
  });
});
