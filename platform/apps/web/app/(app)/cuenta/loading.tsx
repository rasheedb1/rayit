import { MESSAGES } from "@/lib/auth/messages";

/** Esqueleto del mismo tamaño que la pantalla real, para que el salto no despiste. */
export default function CuentaLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.cuenta.titulo}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-3/4 animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="flex max-w-md flex-col gap-5">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="h-3 w-16 animate-pulse rounded-sm bg-hover" />
            <span className="h-9 w-full animate-pulse rounded-md bg-hover" />
          </div>
        ))}
        <span className="h-9 w-24 animate-pulse rounded-md bg-hover" />
      </div>
    </div>
  );
}
