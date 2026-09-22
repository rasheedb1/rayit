import { MESSAGES } from "./messages";

/**
 * Esqueleto del segmento mientras la base responde: la cabecera, el
 * bloque de condiciones y cinco filas del alto de la tabla real, para
 * que una consulta lenta no deje la navegación sin señal.
 */
export default function CotizarLoading() {
  const t = MESSAGES.loading;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="rounded-md border border-border p-4">
        <span className="block h-4 w-48 animate-pulse rounded-sm bg-hover" />
        <div className="mt-3 flex flex-wrap gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="h-4 w-40 animate-pulse rounded-sm bg-hover" />
          ))}
        </div>
      </div>
      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">{t.section}</span>
          <span className="h-3 w-20 animate-pulse rounded-sm bg-hover" />
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-4 last:border-b-0">
              <span className="h-4 w-1/4 animate-pulse rounded-sm bg-hover" />
              <span className="hidden h-4 w-1/6 animate-pulse rounded-sm bg-hover sm:block" />
              <span className="ml-auto h-4 w-32 animate-pulse rounded-sm bg-hover" />
              <span className="hidden h-4 w-20 animate-pulse rounded-sm bg-hover sm:block" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
