import { MESSAGES } from "../../_lib/messages";

/**
 * La ficha de una empresa mientras carga: la cabecera, la lista de
 * negocios y la columna de datos, del tamaño de lo que viene.
 *
 * Lo pinta (ficha)/loading.tsx, que está DEBAJO del layout que
 * comprueba que la empresa existe: uno por encima de ese layout mandaría
 * el 200 antes del notFound() (app/(app)/no-existe.test.tsx).
 */
export function EsqueletoFicha() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.ficha}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-2/3 animate-pulse rounded-sm bg-hover" />
        <span className="mt-2 block h-4 w-1/3 animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-2">
          <span className="block h-5 w-24 animate-pulse rounded-sm bg-hover" />
          {Array.from({ length: 3 }, (_, i) => (
            <span key={i} className="block h-14 w-full animate-pulse rounded-md bg-hover" />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <span className="block h-9 w-full animate-pulse rounded-md bg-hover" />
          <span className="block h-9 w-full animate-pulse rounded-md bg-hover" />
          <span className="block h-40 w-full animate-pulse rounded-md bg-hover" />
        </div>
      </div>
    </div>
  );
}
