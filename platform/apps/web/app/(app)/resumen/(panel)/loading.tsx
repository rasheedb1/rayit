import { GraficosEsqueleto } from "../graficos";
import { KpisEsqueleto } from "../kpis";
import { MESSAGES } from "../messages";

/**
 * Esqueleto de la pantalla mientras la base responde: la misma cabecera,
 * la misma fila de KPIs y las mismas dos tarjetas de gráfico, del mismo
 * tamaño que la pantalla real, para que una consulta lenta no deje la
 * navegación congelada sin señal ni desplace el contenido al llegar.
 *
 * Vive dentro del grupo de rutas `(panel)` —que no cambia la URL— y no
 * en `resumen/` a propósito: el `loading.tsx` de un segmento es el
 * fallback de Suspense de ese segmento Y DE SUS RUTAS ANIDADAS, así que
 * puesto un nivel más arriba este esqueleto, con sus cuatro KPIs
 * falsos, se colaba también en /resumen/importar, que no tiene ninguno.
 */
export default function ResumenLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <KpisEsqueleto />
      <div className="mt-4">
        <GraficosEsqueleto />
      </div>
    </div>
  );
}
