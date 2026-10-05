/**
 * Una vez por `vitest run`, antes de arrancar los procesos (CIM-12).
 *
 * Fija MC_PGLITE_CORRIDA, que heredan todos los procesos de vitest: con
 * ella, la demo sembrada va a disco (packages/db/src/embedded.ts) y la
 * siembra UN proceso por corrida en vez de cada uno la suya. Antes, cada
 * proceso (uno por núcleo) volvía a sembrar encima de la foto del esquema,
 * y con dos o cuatro verificar a la vez eso eran decenas de siembras
 * compitiendo por la CPU: los beforeAll pasaban de su techo.
 *
 * Al terminar borra la carpeta de la corrida, y de paso las de corridas
 * que murieron sin borrarla (más de dos horas).
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { carpetaDeCorrida } from "@mc/db/embedded";

const CORRIDA_VIEJA_MS = 2 * 60 * 60_000;

export default async function setup(): Promise<() => Promise<void>> {
  // Si ya viene de fuera (otra herramienta que la fijó), no es nuestra: no se borra.
  const propia = !process.env.MC_PGLITE_CORRIDA;
  if (propia) process.env.MC_PGLITE_CORRIDA = `web-${process.pid}-${Date.now()}`;
  const carpeta = carpetaDeCorrida(process.env.MC_PGLITE_CORRIDA!);

  const corridas = dirname(carpeta);
  for (const nombre of await readdir(corridas).catch(() => [] as string[])) {
    const ruta = join(corridas, nombre);
    const vieja = await stat(ruta).then((s) => Date.now() - s.mtimeMs > CORRIDA_VIEJA_MS, () => false);
    if (vieja) await rm(ruta, { recursive: true, force: true }).catch(() => undefined);
  }

  return async () => {
    if (propia) await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  };
}
