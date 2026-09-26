import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lo que decide la PÁGINA de aprobaciones (VEN-14): quién ve la cola. La
 * cola, las filas y las acciones tienen su prueba en aprobaciones.test.tsx;
 * las consultas, contra Postgres embebido.
 */
const estado = vi.hoisted(() => ({ ver: true, operar: true, cargas: 0 }));

vi.mock("@mc/db/queries/bandejas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/bandejas")>()),
  listApprovalQueue: async () => {
    estado.cargas++;
    return { items: [], total: 0 };
  },
}));
vi.mock("@mc/db/queries/entregabilidad", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/entregabilidad")>()),
  getOutboundPolicy: async () => ({ enabled: true }),
}));
vi.mock("@mc/db/queries/outreach", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/outreach")>()),
  outreachWriterStatus: async () => "model",
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
vi.mock("../_lib/permiso", () => ({
  puedeVerBandejas: async () => estado.ver,
  puedeOperarVentas: async () => estado.operar,
}));
vi.mock("./actions", () => ({
  aprobarToque: vi.fn(),
  regenerarToque: vi.fn(),
  saltarToque: vi.fn(),
  deshacerAprobacion: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { MESSAGES } from "./messages";
import AprobacionesPage from "./page";

const t = MESSAGES;

beforeEach(() => {
  estado.ver = true;
  estado.operar = true;
  estado.cargas = 0;
});

describe("la página de aprobaciones", () => {
  it("un 'client' (la marca misma, en una agencia) no ve los mensajes a otras marcas: la cola ni se carga", async () => {
    estado.ver = false;
    estado.operar = false;
    render(await AprobacionesPage());
    expect(screen.getByText(t.sinPermisoVer.title)).toBeInTheDocument();
    expect(estado.cargas).toBe(0);
  });

  it("un 'viewer' ve la cola", async () => {
    estado.operar = false;
    render(await AprobacionesPage());
    expect(estado.cargas).toBe(1);
    expect(screen.queryByText(t.sinPermisoVer.title)).toBeNull();
  });
});
