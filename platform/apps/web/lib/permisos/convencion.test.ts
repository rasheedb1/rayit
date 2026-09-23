// @vitest-environment node
/**
 * La convención de ACC-1, sin revisión humana: toda Server Action de los
 * módulos que la adoptaron abre con `await requirePermission("<permiso
 * del catálogo>")` como primera línea de código, o lleva el comentario
 * `// TODO(ACC-1): <permiso>` en su lugar.
 *
 * Es una prueba estática: lee los actions.ts de app/(app)/<módulo>/ y
 * mira el cuerpo de cada `export async function`. Sin AST: un escáner
 * de paréntesis cierra la firma (que puede ocupar varias líneas, como
 * moverNegocio en Ventas) y luego se lee línea a línea saltando
 * comentarios y vacías. Cuando Rasheed adopte la convención en Resumen,
 * Ventas y Cotizar, agrega el módulo a MODULOS_CON_CONVENCION.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPermiso } from "@mc/core";

const AQUI = dirname(fileURLToPath(import.meta.url));
const APP = join(AQUI, "..", "..", "app", "(app)");

/** Los módulos cuyas Server Actions ya abren con requirePermission. */
const MODULOS_CON_CONVENCION = ["campanas", "finanzas", "conexiones"] as const;

/** Cuántas acciones exportadas tenían esos módulos al adoptar la convención: si baja, la prueba dejó de mirar algo. */
const ACCIONES_MINIMAS = 12;

interface Accion {
  nombre: string;
  /** La primera línea de código del cuerpo, sin espacios. */
  primeraLinea: string;
  /** Los comentarios de línea entre la llave y la primera línea de código. */
  comentarios: string[];
}

interface Hallazgo {
  archivo: string;
  nombre: string;
  motivo: string;
}

/** Los actions.ts debajo de una carpeta, en orden estable. */
function actionsDe(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir).sort()) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) out.push(...actionsDe(ruta));
    else if (nombre === "actions.ts") out.push(ruta);
  }
  return out;
}

/** Las funciones exportadas de un archivo "use server" y cómo empieza cada cuerpo. */
export function accionesExportadas(src: string): Accion[] {
  const out: Accion[] = [];
  const cabecera = /^export async function (\w+)\s*\(/gm;
  for (let m = cabecera.exec(src); m; m = cabecera.exec(src)) {
    // Cerrar la firma: el paréntesis de apertura ya se consumió.
    let i = m.index + m[0].length;
    let profundidad = 1;
    while (i < src.length && profundidad > 0) {
      const c = src[i];
      if (c === "(") profundidad++;
      else if (c === ")") profundidad--;
      i++;
    }
    const llave = src.indexOf("{", i);
    if (llave < 0) continue;
    const cuerpo = src.slice(llave + 1).split("\n");
    const comentarios: string[] = [];
    let primeraLinea = "";
    let enBloque = false;
    for (const cruda of cuerpo) {
      const linea = cruda.trim();
      if (enBloque) {
        if (linea.includes("*/")) enBloque = false;
        continue;
      }
      if (linea === "") continue;
      if (linea.startsWith("//")) {
        comentarios.push(linea);
        continue;
      }
      if (linea.startsWith("/*")) {
        if (!linea.includes("*/")) enBloque = true;
        continue;
      }
      primeraLinea = linea;
      break;
    }
    out.push({ nombre: m[1]!, primeraLinea, comentarios });
  }
  return out;
}

const LLAMADA = /^await requirePermission\("([^"]+)"\);$/;
const TODO = /^\/\/ TODO\(ACC-1\): (\S+)$/;

/** Por qué una acción no cumple, o null si cumple. */
export function motivoDeIncumplimiento(a: Accion): string | null {
  const llamada = LLAMADA.exec(a.primeraLinea);
  if (llamada) {
    return isPermiso(llamada[1]!) ? null : `pide el permiso «${llamada[1]}», que no está en el catálogo`;
  }
  const todo = a.comentarios.map((c) => TODO.exec(c)).find((x) => x !== null);
  if (todo) {
    return isPermiso(todo[1]!) ? null : `el TODO(ACC-1) nombra «${todo[1]}», que no está en el catálogo`;
  }
  return `su primera línea es «${a.primeraLinea || "(vacía)"}» y no una llamada a requirePermission ni un TODO(ACC-1)`;
}

/** Recorre los archivos y devuelve lo que no cumple. Exportado para que la propia prueba se pruebe. */
export function revisarArchivo(ruta: string, src: string): { acciones: Accion[]; hallazgos: Hallazgo[] } {
  const acciones = accionesExportadas(src);
  const hallazgos: Hallazgo[] = [];
  const importa = /import\s*\{[^}]*\brequirePermission\b[^}]*\}\s*from\s*"@\/lib\/permisos"/.test(src);
  for (const a of acciones) {
    const motivo = motivoDeIncumplimiento(a);
    if (motivo) hallazgos.push({ archivo: ruta, nombre: a.nombre, motivo });
    else if (LLAMADA.test(a.primeraLinea) && !importa) {
      hallazgos.push({ archivo: ruta, nombre: a.nombre, motivo: 'llama a requirePermission sin importarlo de "@/lib/permisos"' });
    }
  }
  return { acciones, hallazgos };
}

describe("toda Server Action de los módulos con la convención abre con requirePermission()", () => {
  const archivos = MODULOS_CON_CONVENCION.flatMap((m) => actionsDe(join(APP, m)));

  it("encuentra los actions.ts de cada módulo (si esto falla, la prueba dejó de mirar)", () => {
    // En el orden de MODULOS_CON_CONVENCION.
    expect(archivos.map((r) => relative(APP, r))).toEqual([
      "campanas/[id]/actions.ts",
      "finanzas/facturas/actions.ts",
      "conexiones/actions.ts",
    ]);
  });

  it("cada función exportada empieza con la llamada (o con su TODO), con un permiso del catálogo", () => {
    let total = 0;
    const hallazgos: Hallazgo[] = [];
    for (const ruta of archivos) {
      const r = revisarArchivo(relative(APP, ruta), readFileSync(ruta, "utf8"));
      expect(r.acciones.length, `${relative(APP, ruta)} no tiene acciones exportadas`).toBeGreaterThan(0);
      total += r.acciones.length;
      hallazgos.push(...r.hallazgos);
    }
    expect(total).toBeGreaterThanOrEqual(ACCIONES_MINIMAS);
    expect(hallazgos.map((h) => `${h.archivo} · ${h.nombre}: ${h.motivo}`)).toEqual([]);
  });
});

describe("el escáner detecta lo que tiene que detectar", () => {
  const cabecera = 'import { requirePermission } from "@/lib/permisos";\n';

  it("acepta la llamada como primera línea, aunque la firma ocupe varias líneas y haya comentarios antes", () => {
    const src =
      cabecera +
      `export async function mover(\n  id: string,\n  opts: { a?: string } = {},\n): Promise<void> {\n` +
      `  // Los argumentos llegan de un POST.\n  /* bloque\n     de dos líneas */\n` +
      `  await requirePermission("campanas.campana.editar");\n  return;\n}\n`;
    const r = revisarArchivo("x.ts", src);
    expect(r.acciones.map((a) => a.nombre)).toEqual(["mover"]);
    expect(r.hallazgos).toEqual([]);
  });

  it("rechaza una acción cuya primera línea no es la llamada", () => {
    const src = cabecera + `export async function crear(fd: FormData): Promise<void> {\n  const x = 1;\n  await requirePermission("finanzas.factura.crear");\n}\n`;
    const r = revisarArchivo("x.ts", src);
    expect(r.hallazgos).toHaveLength(1);
    expect(r.hallazgos[0]!.motivo).toMatch(/primera línea es «const x = 1;»/);
  });

  it("rechaza un permiso que no está en el catálogo, en la llamada y en el TODO", () => {
    const a = cabecera + `export async function crear(): Promise<void> {\n  await requirePermission("finanzas.factura.borrar");\n}\n`;
    expect(revisarArchivo("a.ts", a).hallazgos[0]!.motivo).toMatch(/«finanzas.factura.borrar», que no está en el catálogo/);
    const b = `export async function crear(): Promise<void> {\n  // TODO(ACC-1): finanzas.factura.borrar\n  return;\n}\n`;
    expect(revisarArchivo("b.ts", b).hallazgos[0]!.motivo).toMatch(/TODO\(ACC-1\) nombra «finanzas.factura.borrar»/);
  });

  it("acepta el TODO(ACC-1) con un permiso del catálogo como sustituto provisional", () => {
    const src = `export async function crear(): Promise<void> {\n  // TODO(ACC-1): finanzas.factura.crear\n  return;\n}\n`;
    expect(revisarArchivo("x.ts", src).hallazgos).toEqual([]);
  });

  it("rechaza la llamada si el archivo no la importa de @/lib/permisos", () => {
    const src = `export async function crear(): Promise<void> {\n  await requirePermission("finanzas.factura.crear");\n}\n`;
    expect(revisarArchivo("x.ts", src).hallazgos[0]!.motivo).toMatch(/sin importarlo/);
  });

  it("no cuenta funciones no exportadas ni las exportadas que no son async", () => {
    const src = `async function interna() {}\nexport function sync() {}\nexport const x = 1;\n`;
    expect(revisarArchivo("x.ts", src).acciones).toEqual([]);
  });
});
