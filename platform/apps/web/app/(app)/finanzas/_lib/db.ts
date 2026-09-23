/**
 * Desde CIM-2 la base y el workspace viven en un solo sitio para toda
 * la web: lib/db (withWorkspace) y lib/workspace/current.ts (desde
 * CIM-3, la sesión). Este archivo solo reexporta para que
 * las pantallas de Finanzas sigan importando "./_lib/db" sin cambios.
 */
export { withWorkspace } from "@/lib/db";
