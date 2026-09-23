/**
 * Consultas del módulo Cimientos: la fila `workspace` misma. Dueño:
 * Rasheed (CIM).
 *
 * Aquí vive la costura de internacionalización del producto. El esquema
 * guarda desde 0001 la moneda, la zona horaria y el locale de cada
 * workspace (schema/cimientos.ts), pero hasta la ronda 4 de CIM-2 nadie
 * leía esa fila: `lib/format.ts` fijaba "es-CO", las pantallas de
 * Finanzas pasaban "COP" a mano y `queries/finanzas.ts` se negaba a
 * facturar en otra moneda. Eso ata el producto a Colombia, que es
 * exactamente lo que el encargo prohíbe: Colombia son los valores POR
 * DEFECTO de un workspace, no una constante del código.
 *
 * Regla: ninguna capa inventa moneda, zona ni locale. Los pide aquí,
 * dentro de la transacción que ya sabe su workspace.
 */
import type { WorkspaceTx } from '../client.ts';
import { workspace } from '../schema/index.ts';

export type Workspace = typeof workspace.$inferSelect;

/** Lo que la interfaz necesita para formatear cifras y fechas. */
export interface WorkspaceSettings {
  id: string;
  name: string;
  /** ISO-4217, en mayúsculas: 'COP', 'MXN', 'USD'. */
  currency: string;
  /** IANA: 'America/Bogota'. */
  timezone: string;
  /** BCP-47, para Intl: 'es-CO'. */
  locale: string;
  /** ISO-3166-1 alfa-2, o null. */
  country: string | null;
}

/**
 * La fila del workspace de la transacción actual. Lanza si no existe:
 * un workspace fijado que no está en la base es un error de
 * configuración (un DEMO_WORKSPACE_ID viejo), no una lista vacía.
 *
 * No hay WHERE, y eso es la regla del paquete, no un descuido: desde la
 * migración 0024 `workspace` lleva RLS y la política deja ver UNA fila,
 * la de current_workspace_id(). Filtrar además en JavaScript con
 * `eq(workspace.id, tx.workspaceId)` era volver a poner el workspace
 * como parámetro de la consulta —lo que el contrato prohíbe— y, peor,
 * daba la impresión de que ESE filtro era el que aislaba: mientras
 * faltó la política, cualquier otra consulta de la tabla veía los
 * inquilinos ajenos y esta parecía prueba de que no.
 *
 * Pero quitar el WHERE deja la corrección al 100% en manos de que 0024
 * esté APLICADA, y hay una ventana documentada en la que no lo está:
 * ALLOW_STALE_SCHEMA=1, la salida para el despliegue que tiene que
 * salir antes de que el integrador corra `make db.migrate`. En esa
 * ventana, `limit(1)` sin ORDER BY sobre una tabla sin RLS devuelve un
 * workspace CUALQUIERA, y su moneda, su locale y su zona horaria se
 * sirven a /finanzas sin que nadie se entere. Así que la fila que vuelve
 * se comprueba: es barato, no vuelve a pasar el workspace a la
 * consulta, y convierte un fallo silencioso en uno ruidoso.
 */
export async function getWorkspace(tx: WorkspaceTx): Promise<Workspace> {
  const [row] = await tx.db.select().from(workspace).limit(1);
  if (!row) {
    throw new Error(
      `El workspace ${tx.workspaceId} no existe en esta base. Revisa DEMO_WORKSPACE_ID (platform/.env.example) ` +
        'o que la base tenga el seed aplicado.',
    );
  }
  if (row.id !== tx.workspaceId) {
    // La política de 0024 no está en esta base: la consulta devolvió el
    // inquilino de otro. Mejor caer que formatear las facturas con la
    // moneda del vecino.
    throw new Error(
      `workspace devolvió la fila de otro inquilino (${row.id} en vez de ${tx.workspaceId}): ` +
        'falta la RLS de la migración 0024 en esta base. Corre: make db.migrate',
    );
  }
  return row;
}

/** Moneda, zona horaria y locale del workspace: lo que formatea la interfaz. */
export async function getWorkspaceSettings(tx: WorkspaceTx): Promise<WorkspaceSettings> {
  const ws = await getWorkspace(tx);
  return {
    id: ws.id,
    name: ws.name,
    currency: ws.currency.toUpperCase(),
    timezone: ws.timezone,
    locale: ws.locale,
    country: ws.country,
  };
}
