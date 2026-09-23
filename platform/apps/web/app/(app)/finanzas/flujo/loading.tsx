import { Kpi, KpiRow } from "@/components/ui/kpi";
import { MESSAGES } from "../_lib/messages";

/**
 * Esqueleto propio: el de Finanzas dice «Cargando facturas» y monta
 * cuatro KPIs y una tabla de seis columnas, que no es lo que viene
 * aquí. Mismo tamaño que la pantalla real —dos KPIs, un gráfico de
 * 260 px y ocho filas— para que la navegación no salte al llegar.
 */
export default function FlujoLoading() {
  const t = MESSAGES.flujo.loading;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-bg-3" />
      </div>
      <KpiRow className="lg:grid-cols-2">
        {t.kpis.map((label) => (
          <Kpi key={label} label={label} value="" loading />
        ))}
      </KpiRow>
      <div className="mt-10 h-[340px] animate-pulse rounded-md border border-line bg-bg-2" />
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-fg">{t.section}</span>
          <span className="h-3 w-20 animate-pulse rounded-sm bg-bg-3" />
        </div>
        <div className="overflow-hidden rounded-md border border-line">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
              <span className="h-4 w-1/4 animate-pulse rounded-sm bg-bg-3" />
              <span className="ml-auto h-4 w-20 animate-pulse rounded-sm bg-bg-3" />
              <span className="hidden h-4 w-20 animate-pulse rounded-sm bg-bg-3 sm:block" />
              <span className="hidden h-4 w-20 animate-pulse rounded-sm bg-bg-3 sm:block" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
