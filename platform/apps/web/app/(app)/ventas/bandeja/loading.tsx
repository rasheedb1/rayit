import { MESSAGES } from "./messages";

/** Esqueleto de la bandeja: la cabecera, la tira de pestañas, la lista a la izquierda y la conversación a la derecha. */
export default function BandejaLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-40 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-6 h-9 animate-pulse border-b border-border" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="grid gap-px overflow-hidden rounded-md border border-border">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="block h-24 animate-pulse bg-hover" />
          ))}
        </div>
        <div className="hidden gap-3 lg:grid">
          <span className="block h-16 animate-pulse rounded-md bg-hover" />
          <span className="block h-32 w-4/5 animate-pulse rounded-md bg-hover" />
          <span className="ml-auto block h-24 w-3/5 animate-pulse rounded-md bg-hover" />
          <span className="block h-28 animate-pulse rounded-md bg-hover" />
        </div>
      </div>
    </div>
  );
}
