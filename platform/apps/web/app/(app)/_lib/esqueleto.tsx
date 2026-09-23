import { MESSAGES } from "./messages";

/**
 * El esqueleto genérico mientras la base responde: un título y tres
 * bloques, porque no sabe qué pantalla viene.
 *
 * Hasta el pulido r4 era `(app)/loading.tsx`, y eso tenía un costo que
 * no se veía: el `loading.tsx` de un segmento es el fallback de Suspense
 * de ese segmento Y DE TODAS SUS RUTAS ANIDADAS. En la raíz de (app)
 * envolvía también cada detalle —/cotizar/cotizaciones/<id>,
 * /ventas/empresas/<id>—, así que Next mandaba el esqueleto, y con él
 * un 200, antes de que la página supiera que el id no existe: el
 * notFound() de después solo pintaba «no encontrado» encima de ese 200
 * (medido con curl). Es lo mismo que el pulido r2 corrigió en (public).
 *
 * Ahora cada segmento de LISTA que lee la base pone su `loading.tsx`
 * (los de Cotizar y Ventas viven en un grupo de rutas, que no cambia la
 * URL, para no envolver sus detalles), y los que no tienen uno propio
 * reexportan este. Un detalle con `notFound()` no lleva ninguno por
 * encima: lo prueba app/(app)/no-existe.test.tsx.
 */
export function EsqueletoGenerico() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-bg-3" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-md border border-line bg-bg-2" />
        ))}
      </div>
    </div>
  );
}
