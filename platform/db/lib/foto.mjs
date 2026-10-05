/**
 * La foto de una base PGlite ya migrada, compartida entre procesos (CIM-12).
 *
 * Migrar un PGlite nuevo con las 77 migraciones cuesta ~5 s de CPU en
 * una máquina tranquila y de 30 a 60 s con la máquina cargada. Antes cada
 * archivo de pruebas del worker y de la web lo hacía por su cuenta: unas
 * sesenta migraciones completas por `pnpm verificar`, y con dos
 * verificar a la vez la CPU se iba en eso y las pruebas que esperan con
 * reloj real (pg-boss, waitFor) pasaban de su tiempo. Ahora se migra UNA
 * vez por contenido de db/migrations y los demás abren la foto
 * (dumpDataDir → loadDataDir), que cuesta menos de un segundo.
 *
 * Dónde: node_modules/.cache/mc-pglite/ de platform (no se versiona, y
 * cada clon tiene la suya). El nombre lleva un hash de:
 *   - la `clave` del que la pide (qué preparación: con qué roles, como
 *     qué usuario),
 *   - el `motor` (la ruta resuelta de @electric-sql/pglite, que lleva la
 *     versión: una foto de otra versión no se carga),
 *   - el nombre y el contenido de cada archivo de db/migrations.
 * Cambiar una migración, añadir otra o subir PGlite da otra foto; no hay
 * que borrar nada a mano. Las de claves viejas se borran al escribir una
 * nueva con el mismo prefijo.
 *
 * Solo esquema, nunca seeds: los seeds se siembran relativos a now(), y
 * una foto sembrada ayer daría la demo de ayer. Quien quiera seeds los
 * aplica encima de la foto (packages/db/src/embedded.ts).
 *
 * Concurrencia: vitest arranca diez procesos a la vez y los diez quieren
 * la misma foto. El primero toma un candado (`open(…, 'wx')`), migra y
 * escribe con un rename atómico; los demás esperan a que aparezca. Un
 * candado de más de diez minutos es de un proceso muerto y se ignora.
 * Nadie lee nunca un archivo a medio escribir.
 *
 * MC_PGLITE_FOTO=0 lo apaga: cada llamada migra en memoria, como antes.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSql, MIGRATIONS_DIR } from './aplicar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** platform/node_modules/.cache/mc-pglite */
export const FOTO_DIR = join(HERE, '..', '..', 'node_modules', '.cache', 'mc-pglite');
const CANDADO_VIEJO_MS = 10 * 60_000;
const ESPERA_MS = 250;

/**
 * El `motor` de quien pide la foto: la ruta real del @electric-sql/pglite
 * que resuelve el módulo `desde` (su import.meta.url). pnpm la guarda con
 * la versión en el nombre (…/@electric-sql+pglite@0.2.17/…).
 */
export function motorDe(desde) {
  return realpathSync(createRequire(desde).resolve('@electric-sql/pglite'));
}

/** Una promesa por clave completa: dentro de un proceso, la foto se lee una vez. */
const enMemoria = new Map();

async function huella({ clave, motor, dir }) {
  const h = createHash('sha256');
  h.update(`clave\0${clave}\0motor\0${motor}\0`);
  for (const f of await listSql(dir)) {
    h.update(`${f}\0`);
    h.update(await readFile(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/** Un prefijo legible para el nombre del archivo: «embebido», «superusuario»… */
function prefijoDe(clave) {
  return (clave.split(':')[0] || 'foto').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'foto';
}

async function existe(ruta) {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

async function leer(ruta) {
  return new Blob([await readFile(ruta)]);
}

/** Construye en un PGlite nuevo, prepara y vuelca. */
async function construir({ PGlite, extensions, preparar }) {
  const pglite = await PGlite.create({ extensions });
  try {
    await preparar(pglite);
    return await pglite.dumpDataDir('none');
  } finally {
    await pglite.close();
  }
}

/** Escribe la foto con un rename atómico y borra las de claves viejas con el mismo prefijo. */
async function guardar(ruta, foto, prefijo) {
  const tmp = `${ruta}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, Buffer.from(await foto.arrayBuffer()));
  await rename(tmp, ruta);
  const nombre = ruta.slice(FOTO_DIR.length + 1);
  for (const f of await readdir(FOTO_DIR).catch(() => [])) {
    if (f !== nombre && f.startsWith(`${prefijo}-`) && f.endsWith('.tar')) {
      await rm(join(FOTO_DIR, f), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Toma el candado de la foto, o espera a que otro proceso la escriba.
 * Devuelve la foto de disco si apareció mientras tanto, o null si este
 * proceso tiene el candado y le toca construirla.
 */
async function candadoOFoto(ruta, candado) {
  for (;;) {
    if (await existe(ruta)) return { foto: await leer(ruta) };
    try {
      const fd = await open(candado, 'wx');
      await fd.close();
      // Otro pudo terminar entre el stat y el open.
      if (await existe(ruta)) {
        await rm(candado, { force: true });
        return { foto: await leer(ruta) };
      }
      return { foto: null };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const viejo = await stat(candado).then((s) => Date.now() - s.mtimeMs > CANDADO_VIEJO_MS, () => false);
      if (viejo) await rm(candado, { force: true });
      // Un temporizador con ref: mientras se espera, el proceso no se da
      // por terminado (node:test cancela todo si el bucle se queda vacío).
      else await new Promise((r) => setTimeout(r, ESPERA_MS));
    }
  }
}

/**
 * La foto (Blob de dumpDataDir) de una base migrada con `preparar`.
 *
 *   PGlite, extensions  el constructor y las extensiones de QUIEN la pide:
 *                       la foto se carga con los mismos.
 *   motor               motorDe(import.meta.url) del que la pide: lleva
 *                       la versión de PGlite en la ruta.
 *   clave               qué preparación es («superusuario», «embebido:…»).
 *                       Lo que cambie la base tiene que cambiar la clave.
 *   preparar(pglite)    roles y migraciones sobre un PGlite nuevo; nunca
 *                       seeds (ver arriba).
 */
export async function fotoMigrada({ PGlite, extensions, motor, clave, preparar, dir = MIGRATIONS_DIR }) {
  if (process.env.MC_PGLITE_FOTO === '0') return construir({ PGlite, extensions, preparar });
  const hash = await huella({ clave, motor, dir });
  let foto = enMemoria.get(hash);
  if (!foto) {
    foto = (async () => {
      const prefijo = prefijoDe(clave);
      const ruta = join(FOTO_DIR, `${prefijo}-${hash}.tar`);
      const candado = `${ruta}.candado`;
      await mkdir(FOTO_DIR, { recursive: true });
      const hallada = await candadoOFoto(ruta, candado);
      if (hallada.foto) return hallada.foto;
      try {
        const nueva = await construir({ PGlite, extensions, preparar });
        await guardar(ruta, nueva, prefijo);
        return nueva;
      } finally {
        await rm(candado, { force: true });
      }
    })();
    enMemoria.set(hash, foto);
    foto.catch(() => enMemoria.delete(hash));
  }
  return foto;
}
