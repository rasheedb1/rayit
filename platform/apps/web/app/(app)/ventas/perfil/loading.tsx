import { MESSAGES } from "./messages";

/**
 * Esqueleto del perfil mientras la base responde: la cabecera, el nombre
 * con sus redes, tres párrafos y la lista de los cinco mejores videos,
 * del tamaño de la pantalla real.
 */
export default function PerfilLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.label}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-40 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="max-w-3xl space-y-10">
        <div className="space-y-3">
          <span className="block h-6 w-48 animate-pulse rounded-sm bg-hover" />
          <div className="grid gap-px sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <span key={i} className="block h-20 animate-pulse rounded-md bg-hover" />
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <span key={i} className="block h-16 w-full animate-pulse rounded-sm bg-hover" />
          ))}
        </div>
        <div className="space-y-px">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="block h-24 w-full animate-pulse rounded-md bg-hover" />
          ))}
        </div>
      </div>
    </div>
  );
}
