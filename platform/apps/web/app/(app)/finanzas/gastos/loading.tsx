import { Kpi, KpiRow } from "@/components/ui/kpi";
import { MESSAGES } from "../_lib/messages";

/**
 * Esqueleto de Gastos. El de Finanzas no sirve aquí: son tres KPIs y no
 * cuatro, y sus etiquetas son de facturas.
 */
export default function GastosLoading() {
  const t = MESSAGES.gastos.cargando;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-24 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-6 h-8 w-64 animate-pulse rounded-md bg-hover" />
      <KpiRow>
        {t.kpis.map((label) => (
          <Kpi key={label} label={label} value="" loading />
        ))}
      </KpiRow>
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">{t.section}</span>
          <span className="h-3 w-28 animate-pulse rounded-sm bg-hover" />
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <span className="h-4 w-2/5 animate-pulse rounded-sm bg-hover" />
              <span className="hidden h-4 w-1/5 animate-pulse rounded-sm bg-hover sm:block" />
              <span className="ml-auto h-4 w-24 animate-pulse rounded-sm bg-hover" />
              <span className="hidden h-4 w-16 animate-pulse rounded-sm bg-hover sm:block" />
            </div>
          ))}
        </div>
      </section>
      <div className="mt-10 h-72 animate-pulse rounded-md border border-border bg-surface" />
    </div>
  );
}
