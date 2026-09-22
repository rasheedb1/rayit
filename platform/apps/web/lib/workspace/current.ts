/**
 * El workspace actual: la costura para que las pantallas avancen sin
 * autenticación.
 *
 * Hoy sale de DEMO_WORKSPACE_ID (ver platform/.env.example); sin él, en
 * desarrollo es el de la creadora del seed. CIM-3 reemplaza este cuerpo
 * por el workspace de la sesión sin tocar a quien lo llama.
 *
 * Es el ÚNICO lugar de la web que conoce el workspace. Las consultas lo
 * reciben dentro de la transacción (withWorkspace), nunca como
 * parámetro suelto ni desde un componente.
 */

/** Workspace de la creadora ficticia del seed (db/seed/0003, docs/propuestas/CIM-8.md). */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Env = Readonly<Record<string, string | undefined>>;

export function getCurrentWorkspaceId(env: Env = process.env): string {
  const id = env.DEMO_WORKSPACE_ID?.trim();
  if (id) {
    if (!UUID_RE.test(id)) {
      throw new Error(`DEMO_WORKSPACE_ID no es un UUID: "${id}". Debe ser el id de una fila de workspace.`);
    }
    return id;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("Falta DEMO_WORKSPACE_ID. Hasta CIM-3 el workspace sale del entorno; en producción no hay uno por defecto.");
  }
  return SEED_WORKSPACE_ID;
}
