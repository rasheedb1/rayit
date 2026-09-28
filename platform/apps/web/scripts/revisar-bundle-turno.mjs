#!/usr/bin/env node
/**
 * ¿El bundle del turno del worker (/api/cron/tick, CIM-7) lee archivos
 * por una ruta de la máquina del build? Corre después de `next build`
 * (es parte del script `build` de @mc/web, así que falla también en
 * Vercel antes de publicar).
 *
 * Por qué: webpack fija `import.meta.url` al `file:///…` de la máquina
 * que hace el build (/Users/… en local, /vercel/path0 en Vercel), y la
 * función corre en /var/task. Un `readFileSync(new URL('./x', import.meta.url))`
 * en código que el turno ejecuta da ENOENT solo en producción: las
 * pruebas corren desde el código fuente y no lo ven. Pasó con los
 * prompts de outreach (ahora en packages/core/src/outreach/prompts.gen.ts)
 * y antes con la CA de Supabase (packages/db/src/supabase-ca.ts).
 *
 * Recorre route.js y los chunks que carga, busca cada `file:///` y
 * falla con cualquier módulo que no esté en PERMITIDOS, cada uno con el
 * motivo por el que su ruta no se usa en producción.
 *
 *   node apps/web/scripts/revisar-bundle-turno.mjs          (desde platform/, tras el build)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = resolve(WEB, '..', '..');
/** La ruta del turno dentro de .next/server. */
export const RUTA_TURNO = join('app', 'api', 'cron', 'tick', 'route.js');

/**
 * Módulos del bundle del turno que llevan su `file:///`, y por qué no
 * es un problema. Añadir uno aquí pide el mismo tipo de motivo: que esa
 * ruta NO se lee en producción.
 */
export const PERMITIDOS = {
  'packages/db/src/tls.ts':
    'PLATFORM_ROOT solo resuelve un PGSSLROOTCERT relativo; en Vercel no se pone y la CA va embebida (supabase-ca.ts)',
  'packages/connectors/src/testing/fixture-fetch.ts':
    'FIXTURES_DIR solo lo lee loadFixture, que usan las pruebas; en producción los conectores van por la red',
  'db/lib/aplicar.mjs':
    'el runner de migraciones solo lo usa el Postgres embebido (sin DATABASE_URL), nunca en producción',
};

/** Los chunks que carga una ruta de Next: `__webpack_require__.X(0, [ids…], …)`. */
export function chunksDe(routeJs) {
  const ids = new Set();
  for (const m of routeJs.matchAll(/\.X\(0,\s*\[([\d,\s]*)\]/g)) {
    for (const id of m[1].split(',').map((x) => x.trim()).filter(Boolean)) ids.add(id);
  }
  return [...ids];
}

/**
 * Los `file:///` del bundle del turno, relativos a platform/, y cuáles
 * no están permitidos. `raiz` es el platform/ de la máquina del build.
 */
export function revisarBundle(serverDir, raiz = PLATFORM) {
  const route = join(serverDir, RUTA_TURNO);
  if (!existsSync(route)) throw new Error(`No está ${route}: ¿se corrió next build?`);
  const routeJs = readFileSync(route, 'utf8');
  const archivos = [route, ...chunksDe(routeJs).map((id) => join(serverDir, 'chunks', `${id}.js`))];
  const prefijo = `${pathToFileURL(raiz).href.replace(/\/$/, '')}/`;
  const encontrados = new Map();
  for (const archivo of archivos) {
    if (!existsSync(archivo)) throw new Error(`El turno carga ${archivo} y no existe`);
    const js = archivo === route ? routeJs : readFileSync(archivo, 'utf8');
    for (const m of js.matchAll(/file:\/\/\/[^"'`\s)]+/g)) {
      const url = m[0];
      const rel = url.startsWith(prefijo) ? decodeURIComponent(url.slice(prefijo.length)) : url;
      if (!encontrados.has(rel)) encontrados.set(rel, archivo);
    }
  }
  const prohibidos = [...encontrados.keys()].filter((rel) => !(rel in PERMITIDOS));
  return { archivos: archivos.length, encontrados: [...encontrados.keys()].sort(), prohibidos: prohibidos.sort() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const r = revisarBundle(join(WEB, '.next', 'server'));
    if (r.prohibidos.length > 0) {
      console.error('El bundle de /api/cron/tick lee archivos por una ruta de la máquina del build (en Vercel darán ENOENT):');
      for (const p of r.prohibidos) console.error(`  ${p}`);
      console.error('Incrústalos como módulo (ver packages/core/scripts/embed-prompts.mjs) o, si esa ruta no se lee en producción,');
      console.error('añádelos a PERMITIDOS en apps/web/scripts/revisar-bundle-turno.mjs con el motivo.');
      process.exit(1);
    }
    console.log(`  bundle del turno: ${r.archivos} archivos, ninguna ruta de la máquina del build fuera de las permitidas (${r.encontrados.length}).`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
