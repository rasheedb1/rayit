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
  followersWeekAgo: null, postsCount: 0, lastPostSnapshotAt: null,
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
  it("dice de cuántas publicaciones tenemos métricas y hasta cuándo llegan", async () => {
    await pintar([{ ...BASE, postsCount: 12, lastPostSnapshotAt: "2026-09-23T05:00:00.000Z" }]);
    const r = fila("nutriveoficial");
    // Lo que dice la plataforma y lo que tenemos medido, sin mezclarse.
    expect(within(r).getByText("140")).toBeInTheDocument();
    expect(within(r).getByText("12 con métricas")).toBeInTheDocument();
    // «Datos hasta» toma la más reciente de las dos series: la lectura
    // de contenido del 23 manda sobre el día de cuenta del 22.
    expect(within(r).getByText(/datos hasta el/).textContent).toContain("23 sep");
  });

  it("sin lecturas de contenido no aparece un cero: la fila calla y manda el día de la cuenta", async () => {
    await pintar([BASE]);
    const r = fila("nutriveoficial");
    expect(within(r).queryByText("0 con métricas")).not.toBeInTheDocument();
    expect(within(r).getByText(/datos hasta el/).textContent).toContain("22 sep");
  });

  it("sin ninguna lectura de ninguna serie lo explica con una frase, no con un guion", async () => {
    await pintar([{ ...BASE, latest: null, lastSyncedAt: null, postsCount: 0, lastPostSnapshotAt: null }]);
    const r = fila("nutriveoficial");
    expect(within(r).getByText("Sin lectura todavía")).toBeInTheDocument();
    expect(within(r).queryByText("—")).not.toBeInTheDocument();
  });

  it("una cuenta cuyas publicaciones medimos pero cuya red no dice cuántas tiene enseña las dos cosas por separado", async () => {
    await pintar([{ ...BASE, latest: { day: "2026-09-22", followers: 38400, mediaCount: null, following: null, views: null }, postsCount: 5, lastPostSnapshotAt: "2026-09-23T05:00:00.000Z" }]);
    const r = fila("nutriveoficial");
    expect(within(r).getAllByText("Sin dato").length).toBeGreaterThan(0);
    expect(within(r).getByText("5 con métricas")).toBeInTheDocument();
  });
});
