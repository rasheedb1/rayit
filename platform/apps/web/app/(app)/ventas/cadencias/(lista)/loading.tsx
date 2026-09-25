import { MESSAGES } from "../messages";

/**
 * Esqueleto de la lista de Cadencias mientras la base responde, con la
 * forma de page.tsx: la cabecera, la tira de pestañas, dos tarjetas y
 * una tabla. Vive en su grupo (lista) para no envolver al detalle, que
 * tiene el suyo debajo del layout que comprueba el id.
 */
export default function CadenciasLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/3 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="mb-6 block h-9 w-full max-w-md animate-pulse rounded-md bg-hover" />
      <span className="mb-3 block h-4 w-40 animate-pulse rounded-sm bg-hover" />
      <div className="mb-10 grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <span key={i} className="block h-36 animate-pulse rounded-md border border-line bg-hover" />
        ))}
      </div>
      <span className="mb-3 block h-4 w-32 animate-pulse rounded-sm bg-hover" />
      <div className="divide-y divide-line rounded-md border border-line">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="block h-12 animate-pulse bg-hover/40" />
        ))}
      </div>
    </div>
  );
}
