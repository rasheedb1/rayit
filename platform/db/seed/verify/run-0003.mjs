#!/usr/bin/env node
/**
 * Verificación del seed 0003 (CIM-8). Es un atajo de run.mjs, el
 * runner genérico: migra en Postgres embebido como un rol sin
 * BYPASSRLS, corre todos los seeds dos veces, compara conteos y
 * ejecuta verify/0003.sql.
 *
 *   node db/seed/verify/run-0003.mjs   ≡   node db/seed/verify/run.mjs 0003
 */
process.argv.push('0003');
await import('./run.mjs');
