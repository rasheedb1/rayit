/**
 * El «terminado cuando» de ACC-5 en el marco, sin base: los seis
 * layouts de módulo y el plan de Accesos con la sesión de un Contador,
 * de un Mánager y de nadie, y con la bandera apagada. La sesión se
 * falsifica en el punto único que la resuelve (permisosDeLaSesion); el
 * camino real contra Postgres embebido está en permisos-marco-db.test.tsx.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { permisosDeRol } from "@mc/core";

const estado = vi.hoisted(() => ({ permisos: new Set<string>() as ReadonlySet<string>, consultas: 0, falla: null as unknown }));
vi.mock("@/lib/permisos/sesion", () => ({
  permisosDeLaSesion: async () => {
    estado.consultas++;
    if (estado.falla) throw estado.falla;
    return estado.permisos;
  },
}));

import CampanasLayout from "./campanas/layout";
import ConexionesLayout from "./conexiones/layout";
import CotizarLayout from "./cotizar/layout";
import FinanzasLayout from "./finanzas/layout";
import ResumenLayout from "./resumen/layout";
import VentasLayout from "./ventas/layout";
import { ModulePlan } from "@/components/module-plan";
import { generateMetadata as tituloDelPlan } from "./plan/[modulo]/page";
import { permisosDelMarco } from "@/components/shell";
import { redirect } from "next/navigation";

const children: ReactNode = <p>contenido</p>;
const layouts = {
  resumen: ResumenLayout,
  ventas: VentasLayout,
  cotizar: CotizarLayout,
  campanas: CampanasLayout,
  finanzas: FinanzasLayout,
  conexiones: ConexionesLayout,
} as const;

/** El digest con el que Next reconoce notFound() y fija el 404; undefined si pasó. */
async function digestDe(pantalla: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pantalla();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}
const NO_ENCONTRADO = "NEXT_HTTP_ERROR_FALLBACK;404";

async function respuestas(): Promise<Record<keyof typeof layouts, "pasa" | "404">> {
  const out = {} as Record<keyof typeof layouts, "pasa" | "404">;
  for (const [slug, Layout] of Object.entries(layouts) as [keyof typeof layouts, (typeof layouts)[keyof typeof layouts]][]) {
    out[slug] = (await digestDe(() => Layout({ children }))) === NO_ENCONTRADO ? "404" : "pasa";
  }
  return out;
}

beforeEach(() => {
  estado.permisos = new Set();
  estado.consultas = 0;
  estado.falla = null;
});

describe("los layouts de módulo con la sesión puesta", () => {
  test("Contador: /campanas responde 404 y /finanzas pasa; el resto 404", async () => {
    estado.permisos = permisosDeRol("creator", "finance");
    expect(await respuestas()).toEqual({ resumen: "404", ventas: "404", cotizar: "404", campanas: "404", finanzas: "pasa", conexiones: "404" });
  });

  test("Mánager: /campanas pasa y /finanzas responde 404 (el mínimo es finanzas.factura.ver y el Mánager no lo tiene: decisión E)", async () => {
    estado.permisos = permisosDeRol("creator", "manager");
    expect(await respuestas()).toEqual({ resumen: "pasa", ventas: "pasa", cotizar: "pasa", campanas: "pasa", finanzas: "404", conexiones: "pasa" });
  });

  test("Dueño: todo pasa; nadie: todo 404", async () => {
    estado.permisos = permisosDeRol("creator", "owner");
    expect(Object.values(await respuestas()).every((r) => r === "pasa")).toBe(true);
    estado.permisos = new Set();
    expect(Object.values(await respuestas()).every((r) => r === "404")).toBe(true);
  });

  test("el layout que pasa devuelve a sus hijos tal cual: no pinta nada por encima", async () => {
    estado.permisos = new Set(["finanzas.factura.ver"]);
    expect(await FinanzasLayout({ children })).toBe(children);
  });
});

describe("las herramientas del equipo con permiso", () => {
  test("/accesos (el plan del módulo) queda detrás de equipo.miembro.ver", async () => {
    expect(await digestDe(() => ModulePlan({ slug: "accesos" }))).toBe(NO_ENCONTRADO);
    estado.permisos = new Set(["equipo.miembro.ver"]);
    expect(await digestDe(() => ModulePlan({ slug: "accesos" }))).toBeUndefined();
  });

  test("el plan de un módulo que no se puede abrir tampoco se ve; Cimientos no pide permiso", async () => {
    const params = (modulo: string) => ({ params: Promise.resolve({ modulo }) });
    expect(await digestDe(() => tituloDelPlan(params("campanas")))).toBe(NO_ENCONTRADO);
    expect((await tituloDelPlan(params("cimientos"))).title).toMatch(/Cimientos/);
    estado.permisos = new Set(["campanas.campana.ver"]);
    expect((await tituloDelPlan(params("campanas"))).title).toMatch(/Campañas/);
  });

  test("la bandera apagada gana: el plan de un módulo de fase 2 es 404 aunque se tenga todo", async () => {
    estado.permisos = permisosDeRol("creator", "owner");
    expect(await digestDe(() => ModulePlan({ slug: "nicho" }))).toBe(NO_ENCONTRADO);
  });
});

describe("la bandera va antes que la sesión (revisión de código)", () => {
  test("un módulo apagado o inexistente es 404 sin consultar la sesión, aunque la base no conteste", async () => {
    estado.falla = new Error("la base no contestó");
    expect(await digestDe(() => ModulePlan({ slug: "nicho" }))).toBe(NO_ENCONTRADO);
    expect(await digestDe(() => tituloDelPlan({ params: Promise.resolve({ modulo: "no-existe" }) }))).toBe(NO_ENCONTRADO);
    expect(estado.consultas).toBe(0);
  });

  test("un módulo sin permiso (Cimientos) no paga la consulta de la sesión", async () => {
    estado.falla = new Error("la base no contestó");
    expect((await tituloDelPlan({ params: Promise.resolve({ modulo: "cimientos" }) })).title).toMatch(/Cimientos/);
    expect(estado.consultas).toBe(0);
  });
});

describe("los permisos del marco (Shell)", () => {
  test("si la base falla, el menú va sin módulos: nunca concede", async () => {
    estado.falla = new Error("la base no contestó");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await permisosDelMarco()).toEqual([]);
  });

  test("una redirección de Next (a /login o /auth/salir) no se traga: sigue su camino", async () => {
    try {
      redirect("/auth/salir?error=identidad");
    } catch (err) {
      estado.falla = err;
    }
    const err = await permisosDelMarco().catch((e: unknown) => e);
    expect((err as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT/);
  });
});
