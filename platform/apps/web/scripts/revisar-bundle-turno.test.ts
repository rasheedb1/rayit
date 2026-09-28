// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error: script .mjs sin tipos (corre con node después de next build).
import { chunksDe, PERMITIDOS, revisarBundle, RUTA_TURNO } from "./revisar-bundle-turno.mjs";

/**
 * CIM-7 · la revisión del bundle del turno, sobre un .next/server de
 * mentira: encuentra los chunks que carga la ruta y falla con un
 * `file:///` fuera de los permitidos (el caso real de loadPrompt en la
 * ronda 2: packages/core/src/outreach/generate.ts).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bundle(raiz: string, chunks: Record<string, string>): string {
  const server = mkdtempSync(join(tmpdir(), "turno-bundle-"));
  dirs.push(server);
  mkdirSync(join(server, "app", "api", "cron", "tick"), { recursive: true });
  mkdirSync(join(server, "chunks"));
  const ids = Object.keys(chunks);
  writeFileSync(join(server, RUTA_TURNO), `var a=t=>t.X(0,[${ids.join(",")}],()=>t(1));`);
  for (const [id, js] of Object.entries(chunks)) writeFileSync(join(server, "chunks", `${id}.js`), js);
  return server;
}

describe("la revisión del bundle del turno (CIM-7)", () => {
  const raiz = "/maquina/del/build/platform";
  const url = (rel: string) => `${pathToFileURL(raiz).href}/${rel}`;

  test("lee los ids de chunk de la ruta", () => {
    expect(chunksDe('e.X(0,[3345,6829, 454],()=>1); e.X(0,[454,77],x)')).toEqual(["3345", "6829", "454", "77"]);
  });

  test("con solo los módulos permitidos, pasa", () => {
    const server = bundle(raiz, {
      "1": `const HERE="${url("packages/db/src/tls.ts")}";`,
      "2": `x("${url("packages/connectors/src/testing/fixture-fetch.ts")}")`,
    });
    const r = revisarBundle(server, raiz);
    expect(r.prohibidos).toEqual([]);
    expect(r.encontrados).toEqual(["packages/connectors/src/testing/fixture-fetch.ts", "packages/db/src/tls.ts"]);
    expect(r.archivos).toBe(3);
  });

  test("un readFileSync relativo a import.meta.url en packages/core o apps/worker lo tumba", () => {
    const server = bundle(raiz, {
      "454": `(0,n.readFileSync)(new URL(\`./prompts/\${e}.md\`,"${url("packages/core/src/outreach/generate.ts")}"),"utf8")`,
      "9": `new URL("./x.json","${url("apps/worker/src/jobs/x.ts")}")`,
    });
    expect(revisarBundle(server, raiz).prohibidos).toEqual(["apps/worker/src/jobs/x.ts", "packages/core/src/outreach/generate.ts"]);
  });

  test("un file:/// de otra máquina tampoco se da por bueno", () => {
    const server = bundle(raiz, { "1": `"file:///vercel/path0/packages/db/src/tls.ts"` });
    expect(revisarBundle(server, raiz).prohibidos).toEqual(["file:///vercel/path0/packages/db/src/tls.ts"]);
  });

  test("sin build, o con un chunk que falta, falla en vez de dar un falso verde", () => {
    const vacio = mkdtempSync(join(tmpdir(), "turno-bundle-"));
    dirs.push(vacio);
    expect(() => revisarBundle(vacio, raiz)).toThrow(/next build/);
    const server = bundle(raiz, { "1": "" });
    rmSync(join(server, "chunks", "1.js"));
    expect(() => revisarBundle(server, raiz)).toThrow(/no existe/);
  });

  test("cada permitido lleva su motivo", () => {
    for (const [modulo, motivo] of Object.entries(PERMITIDOS as Record<string, string>)) {
      expect(motivo.length, modulo).toBeGreaterThan(40);
      expect(modulo).not.toMatch(/^(packages\/core|apps\/worker)\//);
    }
  });
});
