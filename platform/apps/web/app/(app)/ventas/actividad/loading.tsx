import { MESSAGES } from "./messages";

/**
 * Esqueleto de la actividad mientras la base responde, con la forma de la
 * pantalla (page.tsx): la cabecera, la tira de pestañas del módulo, las
 * dos pestañas de la cola, los filtros y una lista de seis filas.
 */
export default function ActividadLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/3 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="mb-6 block h-9 w-full max-w-md animate-pulse rounded-md bg-hover" />
      <div className="flex flex-col gap-5">
        <div className="flex gap-1.5">
          <span className="h-6 w-20 animate-pulse rounded-full bg-hover" />
          <span className="h-6 w-24 animate-pulse rounded-full bg-hover" />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          {Array.from({ length: 3 }, (_, i) => (
            <span key={i} className="block h-14 animate-pulse rounded-md bg-hover" />
          ))}
          <span className="block h-9 w-20 animate-pulse rounded-md bg-hover" />
        </div>
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-3">
              <span className="h-4 w-4 shrink-0 animate-pulse rounded-sm bg-hover" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="block h-4 w-1/2 animate-pulse rounded-sm bg-hover" />
                <span className="block h-3 w-3/4 max-w-sm animate-pulse rounded-sm bg-hover" />
              </div>
              <span className="h-5 w-20 shrink-0 animate-pulse rounded-full bg-hover" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
