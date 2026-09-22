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
 * migración 0022 `workspace` lleva RLS y la política deja ver UNA fila,
 * la de current_workspace_id(). Filtrar además en JavaScript con
 * `eq(workspace.id, tx.workspaceId)` era volver a poner el workspace
 * como parámetro de la consulta —lo que el contrato prohíbe— y, peor,
 * daba la impresión de que ESE filtro era el que aislaba: mientras
 * faltó la política, cualquier otra consulta de la tabla veía los
 * inquilinos ajenos y esta parecía prueba de que no.
 */
export async function getWorkspace(tx: WorkspaceTx): Promise<Workspace> {
  const [row] = await tx.db.select().from(workspace).limit(1);
  if (!row) {
    throw new Error(
      `El workspace ${tx.workspaceId} no existe en esta base. Revisa DEMO_WORKSPACE_ID (platform/.env.example) ` +
        'o que la base tenga el seed aplicado.',
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
