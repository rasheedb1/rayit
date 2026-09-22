import "server-only";
/**
 * Conexiones usa la base compartida de la web (lib/db, de CAM-1): una
 * sola instancia por proceso y la transacción por workspace. TODO(CIM-2):
 * cuando packages/db exponga el cliente real, lib/db se reduce a
 * reexportarlo y este archivo desaparece.
 */
export { getDb, withWorkspace } from "@/lib/db";
