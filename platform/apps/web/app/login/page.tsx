import type { Metadata } from "next";
import Link from "next/link";
import { Marca } from "@/components/marca";
import { faltantesAuth } from "@/lib/auth/config";
import { MESSAGES } from "@/lib/auth/messages";
import { claveDeCaptcha } from "@/lib/auth/captcha";
import { destinoSeguro } from "@/lib/auth/rutas";
import { correoDeSoporte } from "@/lib/soporte";
import { FormularioLogin } from "./formulario";

export const metadata: Metadata = { title: MESSAGES.login.meta };

/** Los errores que /auth/callback puede poner en la URL, ya en español. */
const ERRORES: Record<string, string> = {
  enlace: MESSAGES.callback.errores.enlace,
  otro_navegador: MESSAGES.callback.errores.otroNavegador,
  cancelado: MESSAGES.callback.errores.cancelado,
  sesion: MESSAGES.callback.errores.sesion,
  identidad: MESSAGES.callback.errores.identidad,
};

type Props = { searchParams: Promise<{ next?: string; error?: string }> };

/**
 * La puerta. Vive fuera del grupo (app) a propósito: sin barra lateral,
 * sin navegación y sin selector de espacio, porque todavía no hay
 * espacio ninguno.
 *
 * Quien ya tiene sesión no llega a pintarla: el middleware lo manda a
 * su destino con un 307 (ronda 4). Antes lo hacía esta página, y como
 * /login tenía loading.tsx la redirección salía como un 200 con el
 * esqueleto y un meta refresh de un segundo. El loading.tsx tampoco
 * está: es una pantalla estática, no hay nada que esperar.
 */
export default async function LoginPage({ searchParams }: Props) {
  const { next, error } = await searchParams;
  const destino = destinoSeguro(next);
  const t = MESSAGES.login;
  const faltan = faltantesAuth();
  const captcha = claveDeCaptcha();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
      <Marca />

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
      <p className="mt-2 mb-8 text-sm leading-5 text-ink-2">{t.descripcion}</p>

      {error && (
        <p role="alert" className="mb-5 rounded-md border border-bad/40 bg-bad-wash px-3 py-2 text-sm text-bad">
          {ERRORES[error] ?? MESSAGES.callback.errores.sesion}
          {error === "identidad" && <SalidaDeIdentidad />}
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
        <FormularioLogin
          next={destino}
          captchaSiteKey={captcha.siteKey}
          avisoCaptcha={captcha.siteKey || process.env.NODE_ENV === "production" ? null : t.captchaSinConfigurar}
        />
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

/**
 * Qué hacer con una cuenta bloqueada por identidad (buzón reasignado):
 * escribir a SUPPORT_EMAIL si lo hay, y si no, entrar con otro correo en
 * el campo de abajo. Nunca «escríbenos» sin decir a dónde: era un
 * callejón sin salida justo en el caso más delicado.
 */
function SalidaDeIdentidad() {
  const t = MESSAGES.callback.identidadSalida;
  const correo = correoDeSoporte();
  if (!correo) return <> {t.sinCorreo}</>;
  return (
    <>
      {" "}
      {t.conCorreo}{" "}
      <a href={`mailto:${correo}`} className="break-all font-medium underline underline-offset-2">
        {correo}
      </a>{" "}
      {t.conCorreoSufijo}
    </>
  );
}
