/**
 * Lo que otros módulos pueden usar de Finanzas sin conocerlo por dentro.
 *
 * Campañas (CAM-1) enlaza el botón «Facturar» así:
 *
 *   import { facturarCampana } from "@/app/(app)/finanzas";
 *   <form action={facturarCampana.bind(null, campaign.id)}>
 *     <Button type="submit">Facturar</Button>
 *   </form>
 *
 * Crea la factura en borrador con empresa, campaña y monto de la
 * campaña, y abre su detalle. Si la campaña no tiene monto, lleva al
 * formulario de factura nueva con el aviso.
 */
export { facturarCampana } from "./facturas/actions";
