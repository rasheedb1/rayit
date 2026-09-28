import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, ritmoSeguidores, type BrandFollowerPoint } from "@mc/core";
import type { BrandFollowersAccount, BrandFollowersResult } from "@mc/db";
import { formatterFor } from "@/lib/format";
import { indicesEntre, vistaCuenta } from "../_lib/seguidores";
import { SeguidoresMarca } from "./seguidores";

/**
 * CAM-3 · la sección «Seguidores de la marca»: con la serie del seed de
 * Café Alma dice «×12 el ritmo» y las tres cifras; con una línea base
 * corta lo marca; sin cifra explica por qué con una frase, nunca con un
 * cero ni un guion; y «Actualizar ahora» solo aparece mientras se mide.
 */

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const W = { baselineFrom: "2026-07-27", startsOn: "2026-08-10", endsOn: "2026-08-17" };

/** La serie del seed 0003 §2, con su misma fórmula. */
function serieDelSeed(): BrandFollowerPoint[] {
  const gains = [150, 155, 175, 160, 150, 150, 150, 150];
  let total = 18200;
  const out: BrandFollowerPoint[] = [];
  for (let d = 0; d < 60; d++) {
    total += d === 0 ? 0 : d >= 37 && d <= 44 ? gains[d - 37]! : d > 44 ? 22 + (d * 5) % 9 : 12 + (d * 2) % 3;
    out.push({ day: addDays("2026-07-04", d), followers: total });
  }
  return out.filter((p) => p.day >= "2026-07-26");
}

function cuenta(series: BrandFollowerPoint[], latest?: BrandFollowersAccount["latest"], w = W): BrandFollowersAccount {
  const last = series.at(-1);
  return {
    platformId: "instagram",
    handle: "cafealma",
    series,
    latest: latest !== undefined ? latest : last ? { ...last, source: "business_discovery", handle: "cafealma", capturedAt: `${last.day}T06:00:00Z` } : null,
    dataAsOf: last ? `${last.day}T06:00:00Z` : null,
    ritmo: ritmoSeguidores(series, w),
  };
}

const accion = async () => {};

describe("vistaCuenta", () => {
  it("con el seed de Café Alma: «×12 el ritmo», las tres cifras y las dos ventanas sombreadas", () => {
    const v = vistaCuenta(cuenta(serieDelSeed()), W, f);
    expect(v.pill).toEqual({ kind: "good", text: "×12 el ritmo" });
    expect(v.resumen).toBe("12,9 al día antes · 155 al día en campaña · 1.240 ganados");
    expect(v.notas).toEqual([]);
    expect(v.labels[0]).toBe(f.dayMonth("2026-07-27"));
    expect(v.data.length).toBe(37);
    // 27 jul..9 ago = índices 0..13 (sombreada hasta el 14, donde empieza la campaña); 10..17 ago = 14..21.
    expect(v.shades).toEqual([
      { from: 0, to: 14, label: "Línea base", tone: "muted" },
      { from: 14, to: 21, label: "Campaña", tone: "accent" },
    ]);
    expect(v.asOf).toEqual({ date: "2026-09-01T06:00:00Z", source: "perfil público en Instagram" });
  });

  it("línea base corta: la pastilla lo dice y la nota dice desde cuándo y cuántos días", () => {
    const corta = serieDelSeed().filter((p) => p.day >= "2026-08-06");
    const v = vistaCuenta(cuenta(corta), W, f);
    expect(v.pill.kind).toBe("warn");
    expect(v.pill.text).toMatch(/línea base corta/);
    expect(v.notas.join(" ")).toContain("Línea base desde el 6 de agosto de 2026: 4 días de 14");
  });

  it("sin cifra: la razón con una frase, sin ceros ni guiones", () => {
    const hoy = { day: "2026-09-23", followers: null, source: "not_found", handle: "cafealma", capturedAt: "2026-09-23T07:00:00Z" };
    const v = vistaCuenta(cuenta([], hoy), W, f);
    expect(v.pill).toEqual({ kind: "neutral", text: "No encontrada" });
    expect(v.notas[0]).toMatch(/No encontramos @cafealma en Instagram/);
    expect(v.resumen).toBeNull();
    expect(v.data).toEqual([]);
    const tiktok = vistaCuenta({ ...cuenta([], { ...hoy, source: "no_public_source" }), platformId: "tiktok", handle: "freskomarket" }, W, f);
    expect(tiktok.notas[0]).toMatch(/TikTok no publica los seguidores de @freskomarket/);
    expect(tiktok.notas).toHaveLength(1);
    expect(v.notas).toHaveLength(1);
    const nunca = vistaCuenta(cuenta([], null), W, f);
    expect(nunca.pill.text).toBe("Sin lecturas todavía");
    expect(nunca.notas[0]).toMatch(/desde el 27 de julio de 2026/);
  });

  it("indicesEntre: primer y último índice dentro de la ventana, o null", () => {
    expect(indicesEntre(["2026-08-01", "2026-08-05", "2026-08-09"], "2026-08-02", "2026-08-09")).toEqual({ from: 1, to: 2 });
    expect(indicesEntre(["2026-08-01"], "2026-08-02", null)).toBeNull();
  });
});

describe("SeguidoresMarca", () => {
  const data = (accounts: BrandFollowersAccount[]): BrandFollowersResult => ({ campaignId: "c", ...W, accounts });

  it("pinta la pastilla, el resumen, la curva y «Actualizar ahora» mientras se mide", () => {
    render(<SeguidoresMarca data={data([cuenta(serieDelSeed())])} status="live" f={f} actualizar={accion} resultado={null} avisos={[]} />);
    expect(screen.getByText("×12 el ritmo")).toBeInTheDocument();
    expect(screen.getByText("12,9 al día antes · 155 al día en campaña · 1.240 ganados")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Instagram · @cafealma" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actualizar ahora" })).toBeInTheDocument();
    expect(screen.getByText(/datos hasta el/)).toBeInTheDocument();
  });

  it("una campaña reportada no ofrece actualizar y lo explica; el resultado de la acción se anuncia", () => {
    render(<SeguidoresMarca data={data([cuenta(serieDelSeed())])} status="reported" f={f} actualizar={accion} resultado="ya_hoy" avisos={["YouTube no respondió; inténtalo de nuevo en unos minutos."]} />);
    expect(screen.queryByRole("button", { name: "Actualizar ahora" })).toBeNull();
    expect(screen.getByText(/La medición de la marca terminó/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ya había una lectura de hoy");
    expect(screen.getByRole("status")).toHaveTextContent("YouTube no respondió");
  });

  it("sin cuentas de la marca: el estado vacío con su frase", () => {
    render(<SeguidoresMarca data={data([])} status="live" f={f} actualizar={accion} resultado={null} avisos={[]} />);
    expect(screen.getByText("Esta campaña no tiene cuentas de la marca")).toBeInTheDocument();
  });

  it("sin cifra: la frase va en el sitio del gráfico, sin «0»", () => {
    const hoy = { day: "2026-09-23", followers: null, source: "not_discoverable", handle: "cafealma", capturedAt: "2026-09-23T07:00:00Z" };
    const { container } = render(<SeguidoresMarca data={data([cuenta([], hoy)])} status="live" f={f} actualizar={accion} resultado={null} avisos={[]} />);
    expect(screen.getByText(/Instagram no deja leer @cafealma/)).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toMatch(/\b0\b/);
  });
});
