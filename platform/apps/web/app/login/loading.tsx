import { MESSAGES } from "@/lib/auth/messages";

/** Esqueleto del mismo tamaño que /login: marca, título, campo y botón. */
export default function LoginLoading() {
  return (
    <main
      aria-busy="true"
      aria-label={MESSAGES.login.titulo}
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12"
    >
      <div className="mb-8 flex items-center gap-2.5">
        <span className="h-7 w-7 animate-pulse rounded-md bg-hover" />
        <span className="h-4 w-20 animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="block h-6 w-2/3 animate-pulse rounded-sm bg-hover" />
      <span className="mt-3 mb-8 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      <div className="flex flex-col gap-1.5">
        <span className="h-3 w-14 animate-pulse rounded-sm bg-hover" />
        <span className="h-9 w-full animate-pulse rounded-md bg-hover" />
      </div>
      <span className="mt-5 block h-9 w-full animate-pulse rounded-md bg-hover" />
      <span className="mt-10 block h-3 w-3/4 animate-pulse rounded-sm bg-hover" />
    </main>
  );
}
