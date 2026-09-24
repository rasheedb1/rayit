import { MESSAGES } from "./messages";

/**
 * Esqueleto de la política mientras la base responde: la cabecera, el
 * interruptor, la salud del día y seis campos, del tamaño de la pantalla real.
 */
export default function PoliticaLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-40 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-10 h-20 animate-pulse rounded-md border border-line bg-hover" />
      <div className="mb-10 grid gap-px sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="block h-20 animate-pulse rounded-md bg-hover" />
        ))}
      </div>
      <div className="max-w-2xl space-y-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2">
            <span className="block h-4 w-40 animate-pulse rounded-sm bg-hover" />
            <span className="block h-9 w-32 animate-pulse rounded-md bg-hover" />
            <span className="block h-3 w-full animate-pulse rounded-sm bg-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}
