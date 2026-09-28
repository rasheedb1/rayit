import { MESSAGES } from "./_lib/messages";

/**
 * Esqueleto del segmento mientras la base responde: la cabecera, el
 * bloque de «Agregar cuenta» y seis filas de tabla, del tamaño de la
 * pantalla real. Hasta CON-4 este archivo reexportaba el esqueleto
 * genérico de (app) —tres tarjetas—, que no se parecía a nada de lo que
 * venía después y hacía saltar el contenido al llegar.
 */
export default function CuentasLoading() {
  const t = MESSAGES.loading;
  return (
    <div aria-busy="true" aria-label={t.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-10 rounded-md border border-border bg-surface p-5">
        <span className="block h-4 w-32 animate-pulse rounded-sm bg-hover" />
        <div className="mt-4 grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)_auto]">
          <span className="block h-9 animate-pulse rounded-md bg-hover" />
          <span className="block h-9 animate-pulse rounded-md bg-hover" />
          <span className="block h-9 w-36 animate-pulse rounded-md bg-hover" />
        </div>
      </div>
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">{t.seccion}</span>
          <span className="h-3 w-20 animate-pulse rounded-sm bg-hover" />
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
    </div>
  );
}
