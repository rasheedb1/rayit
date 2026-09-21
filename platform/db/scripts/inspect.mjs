import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdir, readFile } from 'node:fs/promises';
const db = await PGlite.create({ extensions: { citext, pg_trgm } });
const dir = '/Users/rasheedbayter/Documents/multicampaing/platform/db/migrations';
for (const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())
  await db.exec(await readFile(`${dir}/${f}`,'utf8'));
const q = async (sql) => (await db.query(sql)).rows;
console.log('\nReglas del semáforo por severidad y procedencia:\n');
console.table(await q(`SELECT severity AS severidad, evidence_level AS procedencia, count(*)::int AS n
  FROM preflight_rule GROUP BY 1,2 ORDER BY 1,2`));
console.log('\nReglas bloqueantes:\n');
for (const r of await q(`SELECT id, label_es FROM preflight_rule WHERE severity='blocker' ORDER BY id`))
  console.log(`  ${r.id.padEnd(34)} ${r.label_es}`);
console.log('\nCapacidades declaradas por plataforma:\n');
console.table(await q(`SELECT id, capabilities->>'retention_curve' AS retencion,
  capabilities->>'demographics_per_post' AS demog_video,
  capabilities->>'file_download' AS descarga FROM platform ORDER BY id`));
console.log('\nCifras de referencia con fuente:\n');
console.table(await q(`SELECT id, value_num AS valor, unit AS unidad, sample_size AS muestra, evidence_level AS nivel FROM benchmark ORDER BY id`));
console.log('\nCifras vetadas: ' + (await q('SELECT count(*)::int n FROM blocked_claim'))[0].n);
console.log('Reglas del semáforo: ' + (await q('SELECT count(*)::int n FROM preflight_rule'))[0].n + '\n');
await db.close();
