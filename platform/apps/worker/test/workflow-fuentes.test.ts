/**
 * CON-C · costura con WRK: cada variable que enciende una fuente de datos
 * tiene que llegar al worker de producción. El camino elegido en
 * docs/propuestas/WRK.md es `--once` desde GitHub Actions, y un workflow
 * solo pasa las variables que nombra en `env:`. Si falta una, encenderla
 * en Vercel encendería la web y dejaría el worker apagado sin decirlo.
 *
 * Los nombres salen de las constantes de @mc/connectors, no de una lista
 * copiada: si una fuente cambia de variable, esta prueba lo nota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ENSEMBLEDATA_TOKEN_ENV, GOOGLE_API_KEY_ENV, INSTAGRAM_HOUSE_TOKEN_ENV, OAUTH_ENV_NAMES } from '@mc/connectors';

const WORKFLOW = new URL('../../../../.github/workflows/worker-once.yml', import.meta.url);

test('el workflow del worker pasa las variables de todas las fuentes, cada una desde su secreto', async () => {
  const yml = await readFile(WORKFLOW, 'utf8');
  const fuentes = [
    INSTAGRAM_HOUSE_TOKEN_ENV, // CON-10 / CON-5, Instagram por @
    GOOGLE_API_KEY_ENV, // CON-10 / CON-5, YouTube por @
    OAUTH_ENV_NAMES.youtube.clientId, OAUTH_ENV_NAMES.youtube.clientSecret, // CON-8
    OAUTH_ENV_NAMES.tiktok.clientId, OAUTH_ENV_NAMES.tiktok.clientSecret, // CON-3
    ENSEMBLEDATA_TOKEN_ENV, // CON-12
  ];
  for (const nombre of fuentes) {
    assert.match(yml, new RegExp(`^\\s+${nombre}: \\$\\{\\{ secrets\\.${nombre} \\}\\}$`, 'm'), `${nombre} no llega al worker`);
  }
});
