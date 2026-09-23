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
import { sql } from 'drizzle-orm';
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
 * El filtro es `id = current_workspace_id()`, el que ya fijó la
 * transacción, y no un parámetro de JavaScript: filtrar con
 * `eq(workspace.id, tx.workspaceId)` era volver a poner el workspace
 * como parámetro de la consulta —lo que el contrato prohíbe— y daba la
 * impresión de que ESE filtro era el que aislaba. Aislar lo hace la RLS
 * de 0024.
 *
 * Pero hace falta filtrar: desde CIM-3 (0028, `workspace_read_member`)
 * una transacción con identidad ve además los espacios a los que su
 * persona pertenece —es lo que pinta el selector—, así que sin filtro
 * `limit(1)` devolvía cualquiera de ellos a quien tiene dos, y la
 * comprobación de abajo lo convertía en un error en cada pantalla.
 *
 * Y la fila que vuelve se comprueba igual. Sin filtro, en la ventana
 * documentada en la que 0024 no está aplicada (ALLOW_STALE_SCHEMA=1, el
 * despliegue que sale antes de `make db.migrate`), `limit(1)` sobre una
 * tabla sin RLS devolvía un workspace CUALQUIERA y su moneda se servía
 * a /finanzas sin que nadie se enterara. Con el filtro eso ya no pasa,
 * pero la comprobación es barata y deja ruidoso cualquier cambio futuro
 * del filtro o de la función.
 */
export async function getWorkspace(tx: WorkspaceTx): Promise<Workspace> {
  const [row] = await tx.db.select().from(workspace).where(sql`${workspace.id} = current_workspace_id()`).limit(1);
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
