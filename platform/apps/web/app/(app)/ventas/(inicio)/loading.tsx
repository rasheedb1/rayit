import { Kpi, KpiRow } from "@/components/ui/kpi";
import { MESSAGES } from "../_lib/messages";

/**
 * Esqueleto del segmento mientras la base responde: la misma fila de
 * KPIs y un bloque del tamaño de la bandeja, para que una consulta
 * lenta no deje la navegación congelada sin señal.
 *
 * Vive en el grupo de rutas `(inicio)` —que no cambia la URL— y no en
 * `ventas/`: ahí era el fallback de Suspense también de
 * /ventas/empresas/<id>, y un id inexistente respondía 200 con la
 * página de no encontrado (ver app/(app)/_lib/esqueleto.tsx).
 */
export default function VentasLoading() {
  const t = MESSAGES.loading;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <KpiRow>
        {t.kpis.map((label) => (
          <Kpi key={label} label={label} value="" loading />
        ))}
      </KpiRow>
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">{t.section}</span>
          <span className="h-3 w-20 animate-pulse rounded-sm bg-hover" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <span className="block h-3 w-24 animate-pulse rounded-sm bg-hover" />
              {Array.from({ length: 2 }, (_, j) => (
                <div key={j} className="mt-3 rounded-sm border border-border p-3">
                  <span className="block h-4 w-3/4 animate-pulse rounded-sm bg-hover" />
                  <span className="mt-2 block h-3 w-1/2 animate-pulse rounded-sm bg-hover" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
