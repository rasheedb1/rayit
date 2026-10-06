"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "../../accesos/_lib/messages";
import { aceptarInvitacion, type AceptarState } from "./actions";

const t = MESSAGES.aceptar;

/**
 * El botón de aceptar. La aceptación es un POST (Server Action), nunca
 * el GET del enlace: un programa que previsualiza enlaces en el correo
 * no gasta la invitación. Si la base dice que ya no sirve (se usó en
 * otra pestaña, venció mientras se leía), se dice aquí mismo.
 */
export function AceptarInvitacion({ token }: { token: string }) {
  const [estado, accion, enviando] = useActionState<AceptarState, FormData>(aceptarInvitacion.bind(null, token), {});
  return (
    <form action={accion} className="grid gap-3">
      {estado.status && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad-wash px-3 py-2 text-sm text-ink">
          <p className="font-medium">{t.estados[estado.status].titulo}</p>
          <p className="text-ink-2">{t.estados[estado.status].texto}</p>
        </div>
      )}
      <div>
        <Button type="submit" variant="primary" loading={enviando} disabled={Boolean(estado.status)}>
          {t.boton}
        </Button>
      </div>
    </form>
  );
}
