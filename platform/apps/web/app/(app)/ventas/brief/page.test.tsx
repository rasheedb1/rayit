import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HiddenSignals, OutboundBrief } from "@mc/db/queries/brief";

/**
 * Lo que decide la PÁGINA del brief (VEN-7): de quién es, si está
 * activo, cuántas señales deja fuera hoy y qué valores le pasa al
 * formulario. El formulario tiene su prueba en form.test.tsx y las
 * consultas en packages/db/test/brief.test.ts.
 */
const estado = vi.hoisted(() => ({
  brief: null as OutboundBrief | null,
  owner: { id: "c1", displayName: "Laura Gómez", workspaceKind: "creator" } as {
    id: string;
    displayName: string;
    workspaceKind: "creator" | "agency";
  } | null,
  editable: true,
  hidden: { total: 0, byCompany: 0, byCategory: 0 } as HiddenSignals,
}));
const formProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@mc/db/queries/brief", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/brief")>()),
  getBrief: async () => estado.brief,
  getBriefOwner: async () => estado.owner,
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

beforeEach(() => {
  estado.brief = null;
  estado.owner = { id: "c1", displayName: "Laura Gómez", workspaceKind: "creator" };
  estado.editable = true;
  estado.hidden = { total: 0, byCompany: 0, byCategory: 0 };
  formProps.last = null;
});

describe("la página del brief", () => {
  it("sin brief, ofrece uno activo con un nombre para empezar y dice que todavía no hay", async () => {
    render(await BriefPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(t.title);
    expect(screen.getByText(t.of("Laura Gómez"))).toBeInTheDocument();
    expect(screen.getByText(t.none)).toBeInTheDocument();
    const values = formProps.last?.values as { title: string; active: boolean; currency: string };
    expect(values).toMatchObject({ title: t.defaultTitle, active: true, currency: "COP" });
  });

  it("con brief, dice su estado y cuántas señales deja fuera, con el enlace a verlas", async () => {
    estado.brief = BRIEF;
    estado.hidden = { total: 3, byCompany: 1, byCategory: 2 };
    render(await BriefPage());
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
    estado.owner = null;
    render(await BriefPage());
    expect(screen.getByText(t.noCreator.title)).toBeInTheDocument();
    expect(screen.queryByTestId("formulario")).toBeNull();
  });

  it("en una agencia el brief es del espacio, no de su primer creador", async () => {
    estado.owner = { id: "c1", displayName: "Laura Gómez", workspaceKind: "agency" };
    render(await BriefPage());
    expect(screen.getByText(t.ofSpace)).toBeInTheDocument();
    expect(screen.queryByText(t.of("Laura Gómez"))).toBeNull();
  });

  it("a quien no es owner ni admin le pasa el formulario de solo lectura", async () => {
    estado.editable = false;
    render(await BriefPage());
    expect(formProps.last?.editable).toBe(false);
  });

  it("el texto no promete lo que no se cumple: ni «pitch», ni que «Qué buscas» filtre", () => {
    const textos = [t.description, t.wants.help, t.rejects.help, t.fields.notesHelp, t.state.help].join(" ");
    expect(textos).not.toMatch(/pitch/i);
    expect(t.wants.help).toMatch(/no oculta ninguna señal/);
  });
});
