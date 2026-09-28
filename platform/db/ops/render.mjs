#!/usr/bin/env node
/**
 * Rellena la plantilla del disparador del worker (db/ops/cron-tick.sql,
 * CIM-7) con APP_URL y CRON_SECRET y la escribe en la salida estándar.
 *
 *   APP_URL=https://… CRON_SECRET=… node db/ops/render.mjs db/ops/cron-tick.sql | ./scripts/supabase-admin.sh sql-stdin
 *
 * Los dos valores llegan por el ENTORNO, nunca por argumentos: un
 * argumento sale en `ps` y en el historial. Se validan antes de tocar el
 * SQL, porque van dentro de literales: la URL tiene que ser un origen
 * https (sin ruta, sin usuario, sin consulta) y el secreto, solo
 * [A-Za-z0-9_-] de 32 a 256 caracteres (`openssl rand -hex 32` da 64).
 * Nada de comillas: nada que escapar. Lo usa scripts/cron-tick.sh.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PLACEHOLDERS = { appUrl: '{{APP_URL}}', cronSecret: '{{CRON_SECRET}}' };
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

/** El origen https de la web, o RenderError. */
export function appOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new RenderError('APP_URL no es una URL: usa el origen de la web, p. ej. https://on-cue-web.vercel.app');
  }
  if (url.protocol !== 'https:') throw new RenderError('APP_URL tiene que ser https: pg_net llama desde Supabase, por internet');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new RenderError('APP_URL es solo el origen (https://host), sin ruta, usuario ni consulta');
  }
  return url.origin;
}

export function checkSecret(raw) {
  if (typeof raw !== 'string' || !SECRET_RE.test(raw)) {
    throw new RenderError('CRON_SECRET tiene que tener de 32 a 256 caracteres [A-Za-z0-9_-]: genera uno con `openssl rand -hex 32`');
  }
  return raw;
}

export function renderCronTick(template, { appUrl, cronSecret }) {
  const origin = appOrigin(appUrl);
  const secret = checkSecret(cronSecret);
  for (const p of Object.values(PLACEHOLDERS)) {
    if (!template.includes(p)) throw new RenderError(`La plantilla no tiene ${p}`);
  }
  const out = template.replaceAll(PLACEHOLDERS.appUrl, origin).replaceAll(PLACEHOLDERS.cronSecret, secret);
  if (/\{\{[A-Z_]+\}\}/.test(out)) throw new RenderError('Quedó un marcador sin rellenar en la plantilla');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('Uso: APP_URL=… CRON_SECRET=… node db/ops/render.mjs db/ops/cron-tick.sql\n');
    process.exit(2);
  }
  try {
    process.stdout.write(renderCronTick(readFileSync(file, 'utf8'), { appUrl: process.env.APP_URL, cronSecret: process.env.CRON_SECRET }));
  } catch (err) {
    process.stderr.write(`${err instanceof RenderError ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
