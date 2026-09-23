/**
 * Las rutas de otros módulos que la ficha de campaña enlaza, en un solo
 * sitio. Si Finanzas mueve sus facturas (pasó con FIN-3: de /finanzas a
 * /finanzas/facturas), se cambia aquí y la prueba del ciclo
 * (ciclo-db.test.ts) comprueba que «Facturar» (facturarCampana, de
 * Finanzas) redirige justo a esta misma ruta.
 */

/**
 * El detalle de una factura de Finanzas (FIN-1). Vive en Campañas y no en
 * app/(app)/finanzas/index.ts para no tocar Finanzas mientras su cierre
 * corre en paralelo; lo que ata las dos es la prueba del ciclo, que exige
 * que facturarCampana redirija justo aquí. Moverla al índice de Finanzas es
 * cambiar una importación.
 */
export function invoiceHref(invoiceId: string): string {
  return `/finanzas/facturas/${invoiceId}`;
}
