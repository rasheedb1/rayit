/**
 * La foto de una base PGlite ya migrada, compartida entre procesos (CIM-12).
 *
 * Migrar un PGlite nuevo con las 77 migraciones cuesta ~5 s de CPU en
 * una máquina tranquila y de 30 a 60 s con la máquina cargada. Antes cada
 * archivo de pruebas del worker y de la web lo hacía por su cuenta: unas
 * sesenta migraciones completas por `pnpm verificar`, y con dos
 * verificar a la vez la CPU se iba en eso y las pruebas que esperan con
 * reloj real (pg-boss, waitFor) pasaban de su tiempo. Ahora se migra UNA
 * vez por huella y los demás abren la foto (dumpDataDir → loadDataDir),
 * que cuesta menos de un segundo.
 *
 * Dónde: node_modules/.cache/mc-pglite/ de platform (no se versiona, y
 * cada clon tiene la suya), o MC_PGLITE_FOTO_DIR si está (las pruebas de
 * este módulo, para no tocar la caché de verdad). El nombre lleva un hash
 * de TODO lo que decide qué base sale (huella()):
 *   - la `clave` del que la pide (qué preparación: con qué roles, como
 *     qué usuario),
 *   - el `motor` (la ruta resuelta de @electric-sql/pglite, que lleva la
 *     versión: una foto de otra versión no se carga) y los nombres de
 *     las extensiones,
 *   - el código que la construye: este archivo y db/lib/aplicar.mjs (el
 *     runner que escribe schema_migrations y sus checksums), más las
 *     `fuentes` que pase quien la pide (el módulo con su `preparar`),
 *   - el nombre y el contenido de cada archivo de db/migrations.
 * Cambiar una migración, el runner o un `preparar` da otra foto; no hay
 * que borrar nada a mano.
 *
 * Lo que NO entra en la huella: el reloj. Las migraciones no dependen de
 * él: lo único que queda con la hora de migrar son marcas de auditoría de
 * los catálogos (los updated_at de 0011, el created_at por DEFAULT de las
 * filas de catálogo que insertan), que ninguna consulta usa para decidir
 * nada; el resto de now() vive en cuerpos de funciones y en DEFAULT de
 * tablas que se llenan después. Si una
 * migración llegara a sembrar filas que dependan de la fecha, su foto
 * envejecería: habría que meter el día en la `clave`, como hace la foto
 * con seeds de packages/db/src/embedded.ts. Las de huellas viejas con el mismo prefijo se
 * borran al escribir una nueva, si llevan más de una hora sin usarse.
 *
 * Concurrencia: vitest arranca varios procesos a la vez y todos quieren
 * la misma foto. El primero toma un candado (`open(…, 'wx')`) con su
 * `pid@host` dentro, migra y escribe con un rename atómico; los demás
 * esperan a que aparezca. Mientras construye, renueva el mtime del
 * candado cada 2 s (el latido). Un candado es de un proceso muerto, y se
 * ignora, si su pid ya no existe en esta máquina (Ctrl-C, kill -9, el
 * agente que el orquestador reinició), o si es de otra máquina y su
 * latido tiene más de 30 s. Nadie lee nunca un archivo a medio escribir.
 *
 * MC_PGLITE_FOTO=0 lo apaga: cada llamada construye en memoria, como antes.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyMigrations, execPglite, listSql, MIGRATIONS_DIR } from './aplicar.mjs';

export { execPglite };

const HERE = dirname(fileURLToPath(import.meta.url));
/** platform/node_modules/.cache/mc-pglite, o MC_PGLITE_FOTO_DIR. */
export const FOTO_DIR = process.env.MC_PGLITE_FOTO_DIR || join(HERE, '..', '..', 'node_modules', '.cache', 'mc-pglite');

/** Cada cuánto renueva el candado quien construye. */
const LATIDO_MS = 2_000;
/**
 * Un candado de OTRA máquina (una carpeta compartida) sin latido en este
 * tiempo es de un proceso muerto. 30 s y no 15: PGlite es WASM en el
 * hilo principal, y con la máquina a carga 100 una sola migración grande
 * bloquea el bucle de eventos (y el latido) varios segundos.
 */
const LATIDO_VIEJO_MS = 30_000;
/**
 * En ESTA máquina manda el pid: mientras viva, se espera. Salvo que lleve
 * este tiempo sin latido, que es un proceso colgado y no uno lento.
 */
const COLGADO_MS = 5 * 60_000;
/** Un candado vacío (el dueño murió entre crearlo y escribir su pid) se ignora pasado esto. */
const VACIO_VIEJO_MS = 10_000;
/** Cuándo se avisa por stderr de que se está esperando. */
const AVISO_MS = 10_000;
/** Una foto de huella vieja se borra si nadie la ha escrito en este tiempo. */
const FOTO_VIEJA_MS = 60 * 60_000;
const ESPERA_MS = 250;

/**
 * La hora de la máquina en ms, para comparar con el mtime de un archivo.
 * No es Date.now(): las pruebas corren con el reloj anclado
 * (scripts/pruebas/reloj.mjs mueve Date y el reloj de PGlite), y el mtime
 * lo pone el sistema de archivos con la hora de verdad. Con Date.now() un
 * candado vivo parecía de hace meses y otro proceso se lo quitaba, y el
 * latido escribía mtimes del futuro. performance no lo mueve nadie.
 */
const ahora = () => performance.timeOrigin + performance.now();

/** Las extensiones de todas las bases de pruebas, como en Supabase. */
export const EXTENSIONES = ['citext', 'pg_trgm'];

/**
 * El `motor` de quien pide la foto: la ruta real del @electric-sql/pglite
 * que resuelve el módulo `desde` (su import.meta.url). pnpm la guarda con
 * la versión en el nombre (…/@electric-sql+pglite@0.2.17/…).
 */
export function motorDe(desde) {
  return realpathSync(createRequire(desde).resolve('@electric-sql/pglite'));
}

/** { citext, pg_trgm } del mismo PGlite que `motor`, para crear y cargar la base con las mismas. */
export async function extensionesDe(motor) {
  const out = {};
  for (const nombre of EXTENSIONES) {
    // Una ruta calculada: que ningún empaquetador intente resolverla (este
    // módulo no entra en el bundle de la web, pero si alguna vez entrara,
    // así no trae «Critical dependency: the request of a dependency is an expression»).
    const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(join(dirname(motor), 'contrib', `${nombre}.js`)).href);
    out[nombre] = mod[nombre];
  }
  return out;
}

/**
 * El código que construye cualquier foto: si cambia, ninguna foto vieja
 * sirve. Se lee al calcular la huella y no al importar el módulo: el
 * bundle del turno (Vercel) lo importa sin abrir nunca una foto.
 */
const CODIGO = ['aplicar.mjs', 'foto.mjs'];

/** Una promesa por huella: dentro de un proceso, la foto se lee una vez. */
const enMemoria = new Map();

/** Los archivos de `ruta` (o la propia ruta si es un archivo), en orden; sin bajar a subcarpetas (db/seed/verify). */
async function archivosDe(ruta) {
  const s = await stat(ruta);
  if (!s.isDirectory()) return [ruta];
  const entradas = await readdir(ruta, { withFileTypes: true });
  return entradas.filter((e) => e.isFile()).map((e) => join(ruta, e.name)).sort();
}

async function huella({ clave, motor, extensions, dir, fuentes }) {
  const h = createHash('sha256');
  h.update(`clave\0${clave}\0motor\0${motor}\0extensiones\0${Object.keys(extensions ?? {}).sort().join(',')}\0`);
  for (const f of CODIGO) h.update(await readFile(join(HERE, f))).update('\0');
  for (const f of await listSql(dir)) {
    h.update(`${f}\0`);
    h.update(await readFile(join(dir, f)));
    h.update('\0');
  }
  for (const fuente of fuentes) {
    for (const f of await archivosDe(fuente)) {
      h.update(`fuente\0${f}\0`);
      h.update(await readFile(f));
      h.update('\0');
    }
  }
  return h.digest('hex').slice(0, 24);
}

/** Un prefijo legible para el nombre del archivo: «embebido», «superusuario»… */
function prefijoDe(clave) {
  return (clave.split(':')[0] || 'foto').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'foto';
}

/** La foto de disco, o null si no está (o la borraron entre mirar y leer). */
async function leer(ruta) {
  try {
    return new Blob([await readFile(ruta)]);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Construye en un PGlite nuevo (o abierto desde `desde`), prepara y vuelca. */
async function construir({ PGlite, extensions, preparar, desde }) {
  const pglite = await PGlite.create(desde ? { loadDataDir: await desde(), extensions } : { extensions });
  try {
    await preparar(pglite);
    return await pglite.dumpDataDir('none');
  } finally {
    await pglite.close();
  }
}

/** Escribe la foto con un rename atómico y borra las de huellas viejas con el mismo prefijo. */
async function guardar(carpeta, ruta, foto, prefijo) {
  const tmp = `${ruta}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, Buffer.from(await foto.arrayBuffer()));
  await rename(tmp, ruta);
  const nombre = ruta.slice(carpeta.length + 1);
  for (const f of await readdir(carpeta).catch(() => [])) {
    if (f === nombre || !f.startsWith(`${prefijo}-`) || !f.endsWith('.tar')) continue;
    const vieja = await stat(join(carpeta, f)).then((s) => ahora() - s.mtimeMs > FOTO_VIEJA_MS, () => false);
    if (vieja) await rm(join(carpeta, f), { force: true }).catch(() => undefined);
  }
}

const HOST = hostname();
const MIO = `${process.pid}@${HOST}`;

/** ¿Vive el proceso `pid` de esta máquina? EPERM es que vive y es de otro usuario. */
function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Quién tiene el candado y si ya no cuenta. Devuelve null si el candado
 * desapareció mientras se miraba.
 */
async function dueñoDe(candado) {
  let s;
  let texto;
  try {
    s = await stat(candado);
    texto = (await readFile(candado, 'utf8')).trim();
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const edad = ahora() - s.mtimeMs;
  const m = /^(\d+)@(.+)$/.exec(texto);
  if (!m) return { texto, viejo: edad > VACIO_VIEJO_MS };
  const pid = Number(m[1]);
  if (m[2] === HOST) return { texto, pid, viejo: !vivo(pid) || edad > COLGADO_MS };
  return { texto, pid, viejo: edad > LATIDO_VIEJO_MS };
}

/**
 * Toma el candado de la foto, o espera a que otro proceso la escriba.
 * Devuelve la foto de disco si apareció mientras tanto, o null si este
 * proceso tiene el candado y le toca construirla.
 */
async function candadoOFoto(ruta, candado) {
  const inicio = ahora();
  let avisado = false;
  for (;;) {
    const hallada = await leer(ruta);
    if (hallada) return hallada;
    try {
      const fd = await open(candado, 'wx');
      try {
        await fd.writeFile(MIO);
      } finally {
        await fd.close();
      }
      // Otro pudo terminar entre leer y abrir.
      const entretanto = await leer(ruta);
      if (entretanto) {
        await soltar(candado);
        return entretanto;
      }
      return null;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const dueño = await dueñoDe(candado);
    if (dueño?.viejo) {
      // Dos que esperan pueden verlo viejo a la vez y construir los dos:
      // cuesta CPU, pero no rompe nada (cada uno escribe con su rename).
      process.stderr.write(`foto: el candado ${candado} era de ${dueño.texto || 'nadie'}, que ya no está; lo tomo.\n`);
      await rm(candado, { force: true });
      continue;
    }
    if (!avisado && ahora() - inicio > AVISO_MS) {
      avisado = true;
      process.stderr.write(`foto: esperando la foto que construye ${dueño?.pid ? `el pid ${dueño.pid}` : 'otro proceso'} (candado: ${candado})…\n`);
    }
    // Un temporizador CON ref, a propósito. PGlite no abre sockets ni
    // temporizadores: mientras este proceso espera el candado de OTRO, este
    // setTimeout es lo único que mantiene vivo el bucle de eventos. Sin él
    // (un .unref(), un fs.watch con persistent: false), un proceso suelto
    // (`node db/migrate.mjs`, los hijos de foto.test.mjs) saldría con el
    // await sin resolver; lo pilla «dos procesos a la vez» de foto.test.mjs.
    // Dentro de node:test (Node 24+) el runner mantiene vivo el bucle él
    // solo; la cancelación masiva de CIM-12 era otra cosa (un SIGTERM:
    // docs/propuestas/CIM-12.md §Mecanismo).
    await new Promise((r) => setTimeout(r, ESPERA_MS));
  }
}

/** Suelta el candado solo si sigue siendo de este proceso (otro pudo darlo por muerto y tomarlo). */
async function soltar(candado) {
  const texto = await readFile(candado, 'utf8').catch(() => null);
  if (texto?.trim() === MIO) await rm(candado, { force: true });
}

/** Renueva el mtime del candado cada LATIDO_MS hasta que se llame a la función que devuelve. */
function latir(candado) {
  const t = setInterval(() => {
    const s = ahora() / 1000;
    utimes(candado, s, s).catch(() => undefined);
  }, LATIDO_MS);
  t.unref();
  return () => clearInterval(t);
}

/**
 * La foto (Blob de dumpDataDir) de una base preparada con `preparar`.
 *
 *   PGlite, extensions  el constructor y las extensiones de QUIEN la pide:
 *                       la foto se carga con los mismos.
 *   motor               motorDe(import.meta.url) del que la pide: lleva
 *                       la versión de PGlite en la ruta.
 *   clave               qué preparación es («superusuario», «embebido:…»).
 *                       Su primer trozo (hasta «:») es el prefijo del archivo.
 *   preparar(pglite)    roles, migraciones o seeds sobre un PGlite nuevo
 *                       (o abierto desde `desde`).
 *   fuentes             archivos o carpetas cuyo contenido entra en la
 *                       huella: el módulo que define `preparar`, los seeds.
 *   desde()             la foto de la que parte, si no parte de cero.
 *   carpeta             dónde se guarda; por omisión FOTO_DIR.
 */
export async function fotoMigrada({ PGlite, extensions, motor, clave, preparar, dir = MIGRATIONS_DIR, fuentes = [], desde, carpeta = FOTO_DIR }) {
  if (process.env.MC_PGLITE_FOTO === '0') return construir({ PGlite, extensions, preparar, desde });
  const hash = await huella({ clave, motor, extensions, dir, fuentes });
  const prefijo = prefijoDe(clave);
  const ruta = join(carpeta, `${prefijo}-${hash}.tar`);
  let foto = enMemoria.get(ruta);
  if (!foto) {
    foto = (async () => {
      const candado = `${ruta}.candado`;
      await mkdir(carpeta, { recursive: true });
      const hallada = await candadoOFoto(ruta, candado);
      if (hallada) return hallada;
      const parar = latir(candado);
      try {
        const nueva = await construir({ PGlite, extensions, preparar, desde });
        await guardar(carpeta, ruta, nueva, prefijo);
        return nueva;
      } finally {
        parar();
        await soltar(candado);
      }
    })();
    enMemoria.set(ruta, foto);
    foto.catch(() => enMemoria.delete(ruta));
  }
  return foto;
}

/**
 * La base del worker y de los conectores: todas las migraciones aplicadas
 * como el superusuario de PGlite, sin roles de Supabase ni seeds. La
 * misma función para los dos paquetes (antes cada uno tenía su copia de
 * `preparar` bajo la misma clave, y ganaba el primero que escribía).
 *
 * `desde` es el import.meta.url de quien la abre: de ahí salen el motor
 * y las extensiones, para cargarla con el mismo PGlite que la creó.
 * Devuelve la base ya abierta.
 */
export async function abrirSuperusuario({ PGlite, desde }) {
  const motor = motorDe(desde);
  const extensions = await extensionesDe(motor);
  const foto = await fotoMigrada({
    PGlite,
    extensions,
    motor,
    clave: 'superusuario',
    preparar: async (p) => {
      await applyMigrations(execPglite(p), { dir: MIGRATIONS_DIR });
    },
  });
  return PGlite.create({ loadDataDir: foto, extensions });
}
