import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { faltantesAuth, isAuthConfigured } from "@/lib/auth/config";
import { MESSAGES } from "@/lib/auth/messages";
import { destinoSeguro } from "@/lib/auth/rutas";
import { getSesion } from "@/lib/auth/session";
import { FormularioLogin } from "./formulario";

export const metadata: Metadata = { title: "Entrar" };

/** Los errores que /auth/callback puede poner en la URL, ya en español. */
const ERRORES: Record<string, string> = {
  enlace: MESSAGES.callback.errores.enlace,
  cancelado: MESSAGES.callback.errores.cancelado,
  sesion: MESSAGES.callback.errores.sesion,
};

type Props = { searchParams: Promise<{ next?: string; error?: string }> };

/**
 * La puerta. Vive fuera del grupo (app) a propósito: sin barra lateral,
 * sin navegación y sin selector de espacio, porque todavía no hay
 * espacio ninguno.
 */
export default async function LoginPage({ searchParams }: Props) {
  const { next, error } = await searchParams;
  const destino = destinoSeguro(next);
  const t = MESSAGES.login;

  // Quien ya entró no tiene nada que hacer aquí... salvo cuando viene
  // con un error. /auth/callback abre la sesión ANTES de sincronizar,
  // así que un fallo al sincronizar dejaba sesión viva y este redirect
  // se tragaba el mensaje: la persona iba a /resumen sin enterarse de
  // nada. El callback ya cierra la sesión en ese caso, y esto es el
  // cinturón: con ?error= la pantalla SIEMPRE se pinta.
  if (isAuthConfigured() && !error) {
    const sesion = await getSesion();
    if (sesion) redirect(destino);
  }

  const faltan = faltantesAuth();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-2.5">
        <span
          className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-accent-ink"
          aria-hidden="true"
        >
          O
        </span>
        <span className="text-base font-semibold tracking-tight text-ink">{MESSAGES.marca}</span>
      </div>

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
      <p className="mt-2 mb-8 text-sm leading-5 text-ink-2">{t.descripcion}</p>

      {error && (
        <p role="alert" className="mb-5 rounded-md border border-bad/40 bg-bad-wash px-3 py-2 text-sm text-bad">
          {ERRORES[error] ?? MESSAGES.callback.errores.sesion}
        </p>
      )}

      {faltan.length > 0 ? (
        <section className="rounded-md border border-border bg-surface-2 px-5 py-5">
          <h2 className="text-sm font-medium text-ink">{t.sinConfigurar.titulo}</h2>
          <p className="mt-1 text-sm leading-5 text-ink-2">{t.sinConfigurar.descripcion}</p>
          <p className="mt-4 text-xs text-muted">{t.sinConfigurar.variables}</p>
          <ul className="mt-1 space-y-0.5">
            {faltan.map((v) => (
              <li key={v} className="font-mono text-xs text-ink-2">
                {v}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted">{t.sinConfigurar.comandoAyuda}</p>
          <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-ink">
            {t.sinConfigurar.comando}
          </pre>
          <Link href="/resumen" className="mt-5 inline-flex text-sm font-medium text-ink underline underline-offset-4">
            {t.sinConfigurar.seguir}
          </Link>
        </section>
      ) : (
        <FormularioLogin next={destino} />
      )}

      <p className="mt-10 text-xs leading-4 text-muted">
        {t.legal.prefijo}{" "}
        <Link href={t.legal.terminos.href} className="underline underline-offset-2 hover:text-ink">
          {t.legal.terminos.texto}
        </Link>{" "}
        {t.legal.union}{" "}
        <Link href={t.legal.privacidad.href} className="underline underline-offset-2 hover:text-ink">
          {t.legal.privacidad.texto}
        </Link>
        {t.legal.sufijo}
      </p>
    </main>
  );
}
