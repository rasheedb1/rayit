import { MESSAGES } from "./messages";

/**
 * Esqueleto de Canales mientras la base responde, con la forma de la
 * pantalla (page.tsx) para que nada salte al cargar: la cabecera, la tira
 * de pestañas, la línea de la política, el título de sección «Tus
 * canales» y UNA lista con borde y
 * separadores (divide-y), con tres filas: el icono a la izquierda, dos
 * líneas de texto y, a la derecha, la pastilla y el botón.
 */
export default function CanalesLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/3 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="mb-6 block h-9 w-full max-w-md animate-pulse rounded-md bg-hover" />
      <div className="flex flex-col gap-4">
        {/* La línea de la política: el outreach de un espacio nace apagado, así que casi siempre está. */}
        <span className="block h-4 w-full max-w-xl animate-pulse rounded-sm bg-hover" />
        <section>
          <span className="mb-3 block h-4 w-24 animate-pulse rounded-sm bg-hover" />
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-3">
                <span className="h-8 w-8 shrink-0 animate-pulse rounded-md border border-line bg-surface-2" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="block h-4 w-24 animate-pulse rounded-sm bg-hover" />
                    <span className="block h-3 w-3/4 max-w-xs animate-pulse rounded-sm bg-hover" />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="h-5 w-20 animate-pulse rounded-full bg-hover" />
                    <span className="h-8 w-24 animate-pulse rounded-md bg-hover" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
