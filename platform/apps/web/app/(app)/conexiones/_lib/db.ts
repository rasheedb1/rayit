import "server-only";
/**
 * Conexiones comparte con Finanzas la base y la transacción por
 * workspace: una sola instancia por proceso (en modo demo, un solo
 * Postgres embebido). TODO(CIM-2): las dos importarán de packages/db
 * (client.ts) y este archivo desaparece.
 */
export { getDb, withWorkspace } from "../../finanzas/_lib/db";
