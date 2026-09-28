/**
 * Las dos piezas de esqueleto que comparten las pantallas de Finanzas.
 * Están aquí y no repetidas en cada `loading.tsx` para que cambiar el
 * alto de una fila no deje la otra pantalla dando un salto al cargar.
 */

/** La cabecera: antetítulo, título y descripción. */
export function EsqueletoDeCabecera() {
  return (
    <div className="mb-8 max-w-2xl">
      <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
      <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
      <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
    </div>
  );
}

/** El título de la sección, los filtros y seis filas del alto de las reales. */
export function EsqueletoDeTabla({ filas = 6 }: { filas?: number }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="h-4 w-40 animate-pulse rounded-sm bg-hover" />
        <span className="h-3 w-20 animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-3 h-8 w-64 max-w-full animate-pulse rounded-[7px] bg-hover" />
      <div className="overflow-hidden rounded-md border border-border">
        {Array.from({ length: filas }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <span className="h-4 w-2/5 animate-pulse rounded-sm bg-hover" />
            <span className="hidden h-4 w-1/5 animate-pulse rounded-sm bg-hover sm:block" />
            <span className="ml-auto h-4 w-24 animate-pulse rounded-sm bg-hover" />
            <span className="hidden h-4 w-16 animate-pulse rounded-sm bg-hover sm:block" />
          </div>
        ))}
      </div>
    </section>
  );
}
