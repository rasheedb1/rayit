import { MESSAGES } from "../messages";

/**
 * Esqueleto del asistente de importación.
 *
 * Existe porque `loading.tsx` de un segmento es el fallback de Suspense
 * de ese segmento Y de todas sus rutas anidadas: sin este archivo, al
 * entrar a /resumen/importar se veía «Cargando tu resumen» con cuatro
 * KPIs falsos y dos tarjetas de gráfico que esta pantalla no tiene.
 *
 * Lo que esta ruta espera de la base son dos cosas pequeñas —las
 * cuentas a las que se puede pegar un archivo y los ajustes del
 * workspace—, así que el esqueleto es igual de pequeño: cabecera, los
 * cuatro pasos y el recuadro donde se suelta el archivo.
 */
export default function ImportarLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.importar.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-28 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="max-w-3xl">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {MESSAGES.importar.pasos.map((nombre, i) => (
            <li key={nombre} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden="true">·</span>}
              <span className={i === 0 ? "font-medium text-ink" : undefined}>
                {i + 1}. {nombre}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-6">
          <span className="block h-4 w-32 animate-pulse rounded-sm bg-hover" />
          <div className="mt-3 rounded-md border border-dashed border-border px-6 py-10 text-center">
            <span className="mx-auto block h-4 w-64 max-w-full animate-pulse rounded-sm bg-hover" />
          </div>
          <div className="mt-4 space-y-1.5">
            {MESSAGES.importar.pasos.map((n) => (
              <span key={n} className="block h-3 w-52 max-w-full animate-pulse rounded-sm bg-hover" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
