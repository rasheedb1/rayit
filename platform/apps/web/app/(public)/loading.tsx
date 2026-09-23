import { MESSAGES } from "@/app/(app)/cotizar/messages";

/**
 * El esqueleto de las páginas que abre la marca (media kit y
 * cotización) mientras public_media_kit o public_quote responden. Una
 * columna, como el documento que viene: el título, dos cifras grandes y
 * tres filas. Sin él, la pestaña se quedaba en blanco.
 */
export default function PublicoLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-10">
      <span className="sr-only">{MESSAGES.publico.loading}</span>
      <div aria-hidden="true">
        <span className="block h-3 w-24 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-8 w-2/3 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-1/2 animate-pulse rounded-sm bg-hover" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-2 gap-6">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i}>
            <span className="block h-3 w-20 animate-pulse rounded-sm bg-hover" />
            <span className="mt-2 block h-8 w-28 animate-pulse rounded-sm bg-hover" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="divide-y divide-border rounded-md border border-border">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-4">
            <span className="h-4 w-1/3 animate-pulse rounded-sm bg-hover" />
            <span className="h-4 w-24 animate-pulse rounded-sm bg-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}
