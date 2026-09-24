import { MESSAGES } from "./messages";

/**
 * Esqueleto de Canales mientras la base responde: la cabecera, la tira
 * de pestañas y tres tarjetas, una por canal, del tamaño de las reales.
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
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-md border border-border p-4">
            <div className="flex flex-1 flex-col gap-2">
              <span className="block h-4 w-24 animate-pulse rounded-sm bg-hover" />
              <span className="block h-3 w-3/4 animate-pulse rounded-sm bg-hover" />
            </div>
            <span className="h-6 w-20 animate-pulse rounded-full bg-hover" />
          </div>
        ))}
      </div>
    </div>
  );
}
