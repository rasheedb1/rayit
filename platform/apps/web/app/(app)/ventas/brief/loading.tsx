import { MESSAGES } from "../_lib/messages";

/**
 * El brief mientras la base responde: la cabecera y los tres bloques del
 * formulario con el mismo alto (qué buscas, qué no aceptas, estado), para
 * que una consulta lenta no deje la pantalla en blanco ni dé un salto.
 */
export default function BriefLoading() {
  // Campos por bloque: el mismo reparto que brief/form.tsx.
  const bloques = [6, 3, 1];
  return (
    <div aria-busy="true" aria-label={MESSAGES.brief.cargando}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="grid max-w-3xl gap-6">
        {bloques.map((campos, i) => (
          <section key={i} className="rounded-md border border-border p-4">
            <span className="block h-4 w-40 animate-pulse rounded-sm bg-hover" />
            <span className="mt-2 block h-3 w-2/3 animate-pulse rounded-sm bg-hover" />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {Array.from({ length: campos }, (_, j) => (
                <div key={j}>
                  <span className="block h-3 w-24 animate-pulse rounded-sm bg-hover" />
                  <span className="mt-1.5 block h-9 w-full animate-pulse rounded-md bg-hover" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
