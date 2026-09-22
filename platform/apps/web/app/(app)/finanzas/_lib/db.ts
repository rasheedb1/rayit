/**
 * Desde CIM-2 la base y el workspace viven en un solo sitio para toda
 * la web: lib/db (withWorkspace) y lib/workspace/current.ts
 * (DEMO_WORKSPACE_ID hasta CIM-3). Este archivo solo reexporta para que
 * las pantallas de Finanzas sigan importando "./_lib/db" sin cambios.
 */
export { getDb, withWorkspace } from "@/lib/db";
