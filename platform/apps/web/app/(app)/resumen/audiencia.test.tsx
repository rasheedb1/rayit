import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAudience } from "@mc/db";

/**
 * «Quién te ve» en el Resumen (RES-4): la demografía de CON-7 por cuenta,
 * con el filtro de red del panel; sin demografía, dice por qué según la
 * cuenta esté autorizada o sea por @; y lo que no se mide (cuándo
 * publicar) se dice en una frase. Lo falso es la base y el workspace.
 */
const datos = vi.hoisted(() => ({
  audiencias: [] as AccountAudience[],
  cuentas: [] as Array<{ id: string; accessMode: string }>,
}));
vi.mock("@/lib/db", () => ({ withWorkspace: async (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mc/db")>()),
  listAccountAudience: async () => datos.audiencias,
  listAccounts: async () => datos.cuentas,
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { MESSAGES } from "./messages";
import { QuienTeVe } from "./audiencia";

const t = MESSAGES.audiencia;
const IG = "00000002-0000-4000-8000-0000000000a1";
const TT = "00000002-0000-4000-8000-0000000000a2";

/** Lo que dejó el worker para una cuenta autorizada de Instagram (fixture de CON-7, redondeado). */
const nicolas: AccountAudience = {
  connectionId: IG,
  platformId: "instagram",
  handle: "nicolasduartea",
  day: "2026-10-05",
  dimensions: [
    {
      population: "followers", dimension: "age", day: "2026-10-05",
      buckets: [["18-24", 71], ["25-34", 1368], ["35-44", 402]].map(([bucket, absolute]) => ({ bucket: bucket as string, absolute: absolute as number, share: null })),
    },
    { population: "followers", dimension: "gender", day: "2026-10-05", buckets: [{ bucket: "F", absolute: 1210, share: null }, { bucket: "M", absolute: 790, share: null }] },
  ],
  gaps: [],
};

/** Una cuenta de TikTok por @: sin demografía y con el hueco que la migración explica. */
const selva: AccountAudience = {
  connectionId: TT,
  platformId: "tiktok",
  handle: "selvathegolden",
  day: null,
  dimensions: [],
  gaps: [{ metricGroup: "demografia_de_cuenta", requirementId: "tt.audience.auth", requirement: "owner_authorization", messageEs: "TikTok solo entrega la audiencia a la cuenta autorizada.", fixUrl: "/conexiones", day: "2026-10-05", detectedAt: "2026-10-05T05:20:00Z" }],
};

beforeEach(() => {
  datos.audiencias = [nicolas, selva];
  datos.cuentas = [{ id: IG, accessMode: "direct_oauth" }, { id: TT, accessMode: "public_profile" }];
});

describe("Quién te ve (RES-4)", () => {
  it("pinta la demografía de la cuenta autorizada con las mismas barras que Conexiones, y dice lo que no se mide", async () => {
    render(await QuienTeVe({ filtro: { days: 30, platform: null } }));
    expect(screen.getByRole("region", { name: t.title })).toBeInTheDocument();
    expect(screen.getByText("@nicolasduartea")).toBeInTheDocument();
    // Los tramos tal como los lee una persona (conexiones/[id]/audiencia.tsx): el género por su palabra.
    expect(screen.getByText("Mujeres")).toBeInTheDocument();
    expect(screen.getByText("25-34")).toBeInTheDocument();
    expect(screen.getByText(t.cuandoPublicar)).toBeInTheDocument();
    // La cuenta por @ sin demografía no pinta una sección vacía: no está entre las que tienen datos.
    expect(screen.queryByText("@selvathegolden")).not.toBeInTheDocument();
  });

  it("con el filtro en una red sin demografía, explica por qué según la cuenta sea por @ o autorizada", async () => {
    render(await QuienTeVe({ filtro: { days: 30, platform: "tiktok" } }));
    expect(screen.getByText(t.vacio.sinDemografia)).toBeInTheDocument();
    expect(screen.getByText(t.vacio.porArroba)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.vacio.accion })).toHaveAttribute("href", "/conexiones");
  });

  it("con una red que no tiene cuentas, lo dice; con la autorizada sin lecturas aún, dice que llega cada mañana", async () => {
    render(await QuienTeVe({ filtro: { days: 30, platform: "youtube" } }));
    expect(screen.getByText(t.vacio.sinCuentas)).toBeInTheDocument();

    datos.audiencias = [{ ...nicolas, day: null, dimensions: [] }];
    render(await QuienTeVe({ filtro: { days: 30, platform: "instagram" } }));
    expect(screen.getByText(t.vacio.autorizada)).toBeInTheDocument();
  });
});
