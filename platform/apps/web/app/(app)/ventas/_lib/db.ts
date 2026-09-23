/**
 * La base y el workspace de Ventas viven donde los de todos: lib/db
 * (withWorkspace) y lib/workspace/current.ts. Este archivo solo
 * reexporta, para que las pantallas del módulo importen "./_lib/db"
 * igual que hace Finanzas y nadie se vea tentado de abrir el cliente
 * crudo desde una pantalla.
 */
export { withWorkspace } from "@/lib/db";
