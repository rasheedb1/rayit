/**
 * CON-5 · lo que la fila de Cuentas dice de las publicaciones.
 *
 * La base ya prueba que listAccounts devuelve postsCount y
 * lastPostSnapshotAt (packages/db/test/cuentas-publicas.test.ts); esto
 * prueba lo que se VE: que la fila enseña de cuántas publicaciones
 * tenemos métricas, que «hasta cuándo» toma la lectura más reciente de
 * las dos series, y que una cuenta sin lecturas lo dice con una frase y
 * no con un cero ni con un guion mudo.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountRow } from "@mc/db";

vi.mock("./_lib/cuentas-server", () => ({ getCuentasService: () => servicio }));
// ACC-8: la página formatea «Conectada por … el …» con los ajustes del workspace.
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: () => Promise.resolve({ id: "w1", name: "Demo", currency: "COP", timezone: "America/Bogota", locale: "es-CO", country: "CO" }),
}));
vi.mock("./actions", () => ({
  actualizarCuenta: vi.fn(),
  agregarCuenta: vi.fn(),
  desconectarConexion: vi.fn(),
}));

import CuentasPage from "./page";

const BASE: AccountRow = {
  id: "c1", platformId: "youtube", externalAccountId: "UCdemo", handle: "nutriveoficial", displayName: "Nutrivé",
  avatarUrl: null, profileUrl: null, accountType: "channel", status: "active", statusDetail: null,
  secretRef: "public:youtube:nutriveoficial", scopes: [], connectedAt: "2026-09-01T00:00:00.000Z",
  lastSyncedAt: "2026-09-23T05:10:00.000Z", hoursSinceSync: 1, accessExpiresAt: null, tokenExpiringSoon: false,
  consecutiveFailures: 0, postsTracked: 3, failedCalls24h: 0, accessMode: "public_profile",
  latest: { day: "2026-09-22", followers: 38400, mediaCount: 140, following: null, views: 1200000 },
  followersWeekAgo: null, postsCount: 0, lastPostSnapshotAt: null, connectedBy: null,
};

let servicio: { listar: () => Promise<AccountRow[]>; availability: () => Array<{ platformId: string; name: string; offersEs: string; missing: string[] }> };

async function pintar(filas: AccountRow[]) {
  servicio = {
    listar: () => Promise.resolve(filas),
    availability: () => [
      { platformId: "instagram", name: "Instagram", offersEs: "Seguidores y publicaciones.", missing: [] },
      { platformId: "tiktok", name: "TikTok", offersEs: "Solo identidad.", missing: [] },
      { platformId: "youtube", name: "YouTube", offersEs: "Suscriptores y vistas.", missing: [] },
    ],
  };
  render(await CuentasPage({ searchParams: Promise.resolve({}) }));
}

function fila(handle: string): HTMLElement {
  return screen.getByText(`@${handle}`).closest("tr")!;
}

describe("la fila de Cuentas después de que corre el recolector", () => {
  it("dice cuántas publicaciones seguimos y hasta cuándo llegan SUS lecturas, sin mezclarlas con las de la cuenta", async () => {
    await pintar([{ ...BASE, postsCount: 12, lastPostSnapshotAt: "2026-09-23T05:00:00.000Z" }]);
    const r = fila("nutriveoficial");
    // Lo que dice la plataforma y lo que seguimos nosotros, aparte.
    expect(within(r).getByText("140")).toBeInTheDocument();
    expect(within(r).getByText("12 en seguimiento")).toBeInTheDocument();
    // Y cada fecha junto a la cifra que describe: las cifras de la fila
    // son de la serie de cuenta (22), y el contenido va con su nombre (23).
    expect(within(r).getByText(/datos hasta el/).textContent).toContain("22 sep");
    expect(within(r).getByText(/publicaciones hasta el/).textContent).toContain("23 sep");
  });

  it("no promete métricas que todavía no existen: entre descubrir y medir solo dice «en seguimiento»", async () => {
    await pintar([{ ...BASE, postsCount: 25, lastPostSnapshotAt: null }]);
    const r = fila("nutriveoficial");
    expect(within(r).getByText("25 en seguimiento")).toBeInTheDocument();
    expect(within(r).queryByText(/con métricas/)).not.toBeInTheDocument();
    expect(within(r).queryByText(/publicaciones hasta el/)).not.toBeInTheDocument();
  });

  it("sin publicaciones seguidas no aparece un cero", async () => {
    await pintar([BASE]);
    const r = fila("nutriveoficial");
    expect(within(r).queryByText(/en seguimiento/)).not.toBeInTheDocument();
    expect(within(r).getByText(/datos hasta el/).textContent).toContain("22 sep");
  });

  it("sin ninguna lectura de ninguna serie lo explica con una frase, no con un guion", async () => {
    await pintar([{ ...BASE, latest: null, lastSyncedAt: null, postsCount: 0, lastPostSnapshotAt: null }]);
    const r = fila("nutriveoficial");
    expect(within(r).getByText("Sin lectura todavía")).toBeInTheDocument();
    expect(within(r).queryByText("—")).not.toBeInTheDocument();
  });

  it("una cuenta medida cuya red no dice cuántas publicaciones tiene enseña las dos cosas por separado", async () => {
    await pintar([{ ...BASE, latest: null, postsCount: 5, lastPostSnapshotAt: "2026-09-23T05:00:00.000Z" }]);
    const r = fila("nutriveoficial");
    expect(within(r).getByText("5 en seguimiento")).toBeInTheDocument();
    expect(within(r).getByText("Todavía sin cifras de la cuenta")).toBeInTheDocument();
    expect(within(r).getByText(/publicaciones hasta el/).textContent).toContain("23 sep");
  });

  it("ACC-8: si la conectó un tercero lo dice debajo del @; si la conectó el titular, no dice nada", async () => {
    await pintar([
      { ...BASE, connectedBy: { userId: "u2", name: "Andrés Pardo", email: "andres@ejemplo.com", at: "2026-09-20T15:00:00.000Z" } },
      { ...BASE, id: "c2", handle: "propia" },
      { ...BASE, id: "c3", handle: "sinnombre", connectedBy: { userId: "u3", name: null, email: null, at: "2026-09-20T15:00:00.000Z" } },
    ]);
    expect(within(fila("nutriveoficial")).getByText(/^Conectada por Andrés Pardo el 20/)).toBeInTheDocument();
    expect(within(fila("propia")).queryByText(/Conectada por/)).toBeNull();
    expect(within(fila("sinnombre")).getByText(/^Conectada por alguien del equipo el 20/)).toBeInTheDocument();
  });
});
