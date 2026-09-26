import { MESSAGES } from "./messages";

/** Esqueleto de la bandeja de aprobación: la cabecera, la tira de pestañas y tres filas del tamaño de las de verdad. */
export default function AprobacionesLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-40 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-6 h-9 animate-pulse border-b border-border" />
      <div className="grid gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="grid gap-3 rounded-md border border-border p-4 sm:p-5">
            <span className="block h-4 w-1/2 animate-pulse rounded-sm bg-hover" />
            <span className="block h-24 animate-pulse rounded-md bg-hover" />
            <span className="block h-4 w-3/4 animate-pulse rounded-sm bg-hover" />
            <span className="block h-7 w-64 animate-pulse rounded-md bg-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}
