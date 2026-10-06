import { MESSAGES } from "./_lib/messages";

/**
 * Esqueleto de Equipo mientras la base responde: el formulario de
 * invitar y tres filas de personas, con el alto de la pantalla real.
 */
export default function AccesosLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.cargando}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-bg-3" />
      </div>
      <div className="mb-12 grid max-w-3xl gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i}>
            <span className="block h-3 w-20 animate-pulse rounded-sm bg-bg-3" />
            <span className="mt-1.5 block h-9 w-full animate-pulse rounded-md bg-bg-3" />
          </div>
        ))}
      </div>
      <div className="max-w-3xl overflow-hidden rounded-md border border-line">
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-b border-line px-4 py-3 last:border-b-0">
            <span className="block h-4 w-40 animate-pulse rounded-sm bg-bg-3" />
            <span className="mt-2 block h-3 w-56 animate-pulse rounded-sm bg-bg-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
