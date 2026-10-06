// Sonda temporal (se borra antes del commit): qué hay en la demo para el seed 0011.
import { openTestDb } from './pglite.ts';

const t = await openTestDb();
const sql = process.argv[2] ?? 'select 1';
const r = await t.db.asWorker((tx) => tx.query(sql));
console.table(r.rows);
await t.close();
