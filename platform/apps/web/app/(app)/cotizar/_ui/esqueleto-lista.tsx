/**
 * El esqueleto de una lista de Cotizar (cotizaciones, media kits y el
 * formulario de una nueva): la cabecera y unas filas del alto de la
 * tabla. Cada `loading.tsx` que lo usa vive en un segmento SIN detalles
 * debajo (un grupo de rutas o una hoja): un esqueleto por encima de
 * /cotizaciones/<id> mandaría el 200 antes del notFound().
 */
export function EsqueletoLista({ label, filas = 5 }: { label: string; filas?: number }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        {Array.from({ length: filas }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-4 last:border-b-0">
            <span className="h-4 w-1/3 animate-pulse rounded-sm bg-hover" />
            <span className="hidden h-4 w-1/6 animate-pulse rounded-sm bg-hover sm:block" />
            <span className="ml-auto h-4 w-24 animate-pulse rounded-sm bg-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}
