import { Kpi, KpiRow } from "@/components/ui/kpi";
import { MESSAGES } from "../_lib/messages";
import { EsqueletoDeTabla, EsqueletoDeCabecera } from "../_componentes/esqueleto";

/**
 * El esqueleto de /finanzas mientras la base responde: la misma
 * cabecera, la misma fila de cuatro KPI y una tabla del mismo alto que
 * la real, para que una consulta lenta no deje la navegación congelada
 * sin señal.
 *
 * Vive en el grupo de rutas `(inicio)`, que no cambia la URL, y por eso
 * NO envuelve `/finanzas/facturas/<id>`: un `loading.tsx` en la raíz del
 * segmento es el fallback de Suspense de todas sus rutas anidadas, y
 * mandaba este esqueleto —con un 200— antes de que el detalle supiera
 * que el id no existe. Es la lección del pulido r4
 * (app/(app)/_lib/esqueleto.tsx).
 */
export default function CobrosLoading() {
  const t = MESSAGES.cobros.loading;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <EsqueletoDeCabecera />
      <KpiRow>
        {t.kpis.map((label) => (
          <Kpi key={label} label={label} value="" loading />
        ))}
      </KpiRow>
      <div className="mt-10">
        <EsqueletoDeTabla />
      </div>
    </div>
  );
}
