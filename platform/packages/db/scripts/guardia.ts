/**
 * La guardia de esquema (src/esquema.ts) contra la base de DATABASE_URL,
 * como mc_app, y nada más: solo LEE el inventario. Es el paso que va
 * entre `make db.migrate` y `make vercel.deploy PROD=1`:
 *
 *   make db.guardia
 *
 * En producción la web no arranca si la guardia reporta algo
 * (createDbFromEnv lanza, salvo ALLOW_STALE_SCHEMA=1). Correrla antes de
 * desplegar convierte ese 500 de arranque en un aviso en la terminal de
 * quien integra. Sale con 1 si hay algo que decir, con 0 si está en
 * verde.
 */
import { createPgDb, createPool } from '../src/client.ts';
import { estadoDelEsquema, explicarEsquema } from '../src/esquema.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('\n  No hay DATABASE_URL. Corre primero: make db.unlock\n\n');
  process.exit(1);
}

const pool = createPool(url, { sslRootCert: process.env.PGSSLROOTCERT ?? null, applicationName: 'mc-db:guardia', max: 1 });
const db = createPgDb(pool);
try {
  const estado = await estadoDelEsquema(db);
  const problema = explicarEsquema(estado);
  if (problema) {
    process.stderr.write(`\n${problema}\n\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `\n  Guardia en verde: ${estado.aplicadas} migraciones (la última, ${estado.ultima ?? '—'}), ` +
        `${estado.aisladas.length} tablas aisladas, nada sin declarar.\n\n`,
    );
  }
} finally {
  await db.close();
}
