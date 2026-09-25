import { PITCH } from "./messages";

/** El editor del pitch mientras lee el perfil y el borrador: el formulario a la izquierda y la vista previa a la derecha. */
export default function PitchLoading() {
  return (
    <div aria-busy="true" aria-label={PITCH.cargando}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-20 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-hover" />
        <span className="mt-2 block h-4 w-2/3 animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-3">
          <span className="block h-9 w-full animate-pulse rounded-md bg-hover" />
          <span className="block h-9 w-full animate-pulse rounded-md bg-hover" />
          <span className="block h-60 w-full animate-pulse rounded-md bg-hover" />
        </div>
        <span className="block h-72 w-full animate-pulse rounded-md bg-hover" />
      </div>
    </div>
  );
}
