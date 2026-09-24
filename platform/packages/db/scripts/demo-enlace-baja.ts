/**
 * Un enlace de baja que se puede pulsar en local (VEN-15).
 *
 *   pnpm --filter @mc/db demo:enlace-baja
 *
 * El seed de la demo (0005) guarda solo el sha256 de tokens al azar, a
 * propósito: nadie tiene esos enlaces. Para recorrer a mano el camino de
 * la baja hace falta uno cuyo token SÍ se conozca. Esto lo fabrica como
 * lo haría el despachador: un token nuevo (createOptoutToken), su fila en
 * outbound_optout_link para el último correo enviado de la demo (otro
 * intento del mismo toque, con su propio número), y la URL impresa.
 *
 * Solo contra un Postgres LOCAL (Docker de `make up` o cualquiera en
 * localhost): con Supabase se niega, porque escribiría un enlace de baja
 * real en la base de producción. La URL de conexión es la de
 * administración (DB_URL, por defecto la de `make up`); la web se arranca
 * aparte contra la misma base, como dice docs/ventas-outreach.md.
 */
import pg from 'pg';
import { crearEnlaceDeDemo } from '../src/demo-baja.ts';

// La fábrica vive en src/demo-baja.ts: la usa también la web en modo demo
// (lib/db/cliente.ts), que imprime un enlace pulsable al arrancar.
export { crearEnlaceDeDemo, type EnlaceDeDemo } from '../src/demo-baja.ts';

const URL_POR_DEFECTO = 'postgres://mc:mc@localhost:5432/oncue';
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'db', 'host.docker.internal']);

/** Si la URL apunta a una base local. Supabase, o cualquier host remoto, no. */
export function esBaseLocal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return false;
  if (/supabase\.(co|com)$/i.test(u.hostname)) return false;
  return HOSTS_LOCALES.has(u.hostname);
}

async function main(): Promise<void> {
  const url = process.env['DB_URL']?.trim() || URL_POR_DEFECTO;
  if (!esBaseLocal(url)) {
    console.error(
      'demo:enlace-baja solo corre contra un Postgres local (localhost o el Docker de `make up`). ' +
        'Con Supabase escribiría un enlace de baja real en producción: no.',
    );
    process.exit(2);
  }
  const appUrl = process.env['APP_URL']?.trim() || 'http://localhost:3100';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const r = await crearEnlaceDeDemo(client, appUrl);
    if (!r.ok) {
      await client.query('ROLLBACK');
      console.error(
        r.reason === 'sin_toque'
          ? 'No hay ningún correo enviado a una ficha que no esté de baja. Corre `make seed` (demo 0005) primero.'
          : 'Ese toque ya tiene 20 enlaces de prueba. Rehaz la base con `make reset && make seed`.',
      );
      process.exitCode = 1;
      return;
    }
    await client.query('COMMIT');
    console.log(`Enlace de baja para ${r.recipient} (toque ${r.touchId}, intento ${r.attempt}):\n`);
    console.log(`  ${r.url}\n`);
    console.log('El «darse de baja» de un clic de Gmail (RFC 8058), por si quieres probarlo sin navegador:\n');
    console.log(`  curl -i -X POST -d 'List-Unsubscribe=One-Click' '${r.url}/un-clic'\n`);
    console.log('Ábrelo SIN sesión (o en una ventana privada): con la sesión del creador que lo envió, la página no deja darse de baja.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
