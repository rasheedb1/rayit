"use client";

import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MESSAGES } from "@/lib/auth/messages";
import { enviarEnlace, type EstadoLogin } from "./acciones";

/**
 * El estado inicial vive AQUÍ y no en acciones.ts: ese archivo lleva
 * "use server" y Next exige que todos sus exports en tiempo de
 * ejecución sean funciones async (un objeto exportado allí tumba el
 * primer envío con un 500). Mismo patrón que components/workspace-menu.tsx.
 */
const ESTADO_INICIAL: EstadoLogin = { estado: "inicio", email: "" };

/**
 * Un campo y un botón. Es toda la pantalla de entrada, y es a propósito:
 * la referencia son los accesos de Vercel y Linear —marca arriba, una
 * sola decisión, enlace legal abajo— porque cualquier cosa de más aquí
 * es una pregunta que alguien tiene que contestar antes de poder usar
 * el producto.
 *
 * Dos estados en el mismo formulario: pedir el correo y «revisa tu
 * correo». El segundo conserva el correo escrito para poder reenviar
 * sin volver a teclearlo, y ofrece cambiarlo, que es lo que uno busca
 * cuando se equivocó de letra.
 */
export function FormularioLogin({ next }: { next: string }) {
  const [estado, action, pendiente] = useActionState<EstadoLogin, FormData>(enviarEnlace, ESTADO_INICIAL);
  const t = MESSAGES.login;

  if (estado.estado === "enviado") {
    return (
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="email" value={estado.email} />
        <input type="hidden" name="next" value={next} />
        <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-surface-2 px-5 py-6 text-center">
          <MailCheck className="h-5 w-5 text-good" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-medium text-ink">{t.enviado.titulo}</h2>
            <p className="mt-1 text-sm leading-5 text-ink-2">{t.enviado.descripcion}</p>
            <p className="mt-2 break-all font-mono text-xs text-muted">{estado.email}</p>
          </div>
          <p className="text-xs leading-4 text-muted">{t.enviado.spam}</p>
        </div>

        {estado.error && (
          <p role="alert" className="text-sm text-bad">
            {estado.error}
          </p>
        )}
        {estado.reenviado && !estado.error && (
          <p role="status" className="text-sm text-good">
            {t.enviado.reenviado}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button type="submit" name="accion" value="reenviar" variant="secondary" loading={pendiente}>
            {t.enviado.reenviar}
          </Button>
          <Button type="submit" name="accion" value="cambiar" variant="ghost">
            {t.enviado.cambiar}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="accion" value="enviar" />
      <Field label={t.correo} error={estado.error}>
        <Input
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          inputMode="email"
          placeholder={t.correoPlaceholder}
          defaultValue={estado.email}
        />
      </Field>
      <Button type="submit" variant="primary" loading={pendiente} className="w-full">
        {pendiente ? t.enviando : t.enviar}
      </Button>
    </form>
  );
}
