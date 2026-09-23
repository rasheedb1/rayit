import { MESSAGES } from "./_lib/messages";

/**
 * El esqueleto del segmento (app) mientras la base responde.
 *
 * Es deliberadamente genérico —un título y tres bloques— porque no sabe
 * qué pantalla viene: cada módulo que quiera el suyo pone su
 * loading.tsx, como hace Finanzas con su fila de KPIs y su tabla. Lo
 * que esto evita es que una consulta lenta deje la navegación congelada
 * sin ninguna señal, que es lo que pasaba en todas las pantallas menos
 * en una.
 */
export default function AppLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-bg-3" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-bg-3" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-md border border-line bg-bg-2" />
        ))}
      </div>
    </div>
  );
}
