import { MESSAGES } from "../../messages";

/**
 * Esqueleto de la línea de tiempo mientras la base responde, con la forma
 * de page.tsx: la cabecera, las pestañas, las acciones, el resumen y los
 * pasos a la izquierda con los paneles a la derecha.
 */
export default function CadenciaLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-20 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="mb-6 block h-9 w-full max-w-md animate-pulse rounded-md bg-hover" />
      <span className="mb-6 block h-9 w-72 animate-pulse rounded-md bg-hover" />
      <span className="mb-6 block h-10 w-full animate-pulse rounded-sm bg-hover" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="block h-40 animate-pulse rounded-md border border-line bg-hover" />
          ))}
        </div>
        <span className="block h-64 animate-pulse rounded-md border border-line bg-hover" />
      </div>
    </div>
  );
}
