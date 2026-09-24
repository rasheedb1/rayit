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
import { createOptoutToken, optoutTokenHash } from '@mc/core/outreach/deliverability';

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

/** Lo mínimo para una consulta con parámetros (pg.Client, o una transacción de @mc/db en las pruebas). */
interface Consultable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export type EnlaceDeDemo =
  | { ok: true; token: string; url: string; recipient: string; touchId: string; attempt: number }
  | { ok: false; reason: 'sin_toque' | 'demasiados' };

/**
 * El enlace, como lo escribiría el despachador: para el último correo
 * enviado a una ficha que no está de baja, otro intento con su token.
 */
export async function crearEnlaceDeDemo(q: Consultable, appUrl: string): Promise<EnlaceDeDemo> {
  const { rows } = await q.query(
    `SELECT t.id, t.workspace_id, t.contact_id, t.recipient_address::text AS recipient_address,
            coalesce((SELECT max(l.attempt) FROM outbound_optout_link l WHERE l.touch_id = t.id), 0) + 1 AS siguiente
       FROM outbound_touch t
       JOIN contact c ON c.id = t.contact_id
      WHERE t.channel = 'email' AND t.status = 'sent' AND t.recipient_address IS NOT NULL AND NOT c.opted_out
      ORDER BY t.sent_at DESC NULLS LAST, t.id
      LIMIT 1`,
  );
  const toque = rows[0] as
    | { id: string; workspace_id: string; contact_id: string; recipient_address: string; siguiente: number }
    | undefined;
  if (!toque) return { ok: false, reason: 'sin_toque' };
  const intento = Number(toque.siguiente);
  if (intento > 20) return { ok: false, reason: 'demasiados' };
  const token = createOptoutToken();
  await q.query(
    `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6::citext, now(), now())`,
    [optoutTokenHash(token), toque.workspace_id, toque.id, toque.contact_id, intento, toque.recipient_address],
  );
  return {
    ok: true,
    token,
    url: `${appUrl.replace(/\/+$/, '')}/baja/${token}`,
    recipient: toque.recipient_address,
    touchId: toque.id,
    attempt: intento,
  };
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
