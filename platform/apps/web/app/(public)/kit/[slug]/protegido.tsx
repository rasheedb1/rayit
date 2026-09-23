"use client";

import { useEffect, useState, useTransition } from "react";
import type { MediaKitSnapshot } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { browserTimeZone, formatTime } from "@/lib/format";
import { IDIOMA_MENSAJES, MESSAGES } from "@/app/(app)/cotizar/messages";
import { MediaKitVista } from "@/app/(app)/cotizar/_ui/media-kit-vista";
import { abrirMediaKitProtegido, type AbrirKitResultado } from "../../actions";

/**
 * El media kit con contraseña.
 *
 * La contraseña no va en la URL ni deja rastro en el historial: se
 * escribe aquí y viaja en el cuerpo de una Server Action, que la deriva
 * en el servidor y la compara contra el derivado guardado. Si acierta,
 * el snapshot vuelve ya recortado y se pinta con el mismo componente
 * que la versión abierta.
 *
 * Con demasiados fallos, la base bloquea el enlace 15 minutos: la
 * página dice hasta qué hora, en la hora del navegador de quien mira.
 */
export function MediaKitProtegido({ slug, bloqueadoHasta }: { slug: string; bloqueadoHasta?: string }) {
  const t = MESSAGES.publico.kit.password;
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MediaKitSnapshot | null>(null);
  const [pending, startTransition] = useTransition();

  // La hora del bloqueo se escribe en el navegador (su idioma y su
  // zona), después de hidratar: el servidor no sabe dónde está la marca.
  useEffect(() => {
    if (bloqueadoHasta) setError(textoBloqueo(bloqueadoHasta));
  }, [bloqueadoHasta]);

  if (snapshot) return <MediaKitVista snapshot={snapshot} />;

  function enviar(formData: FormData) {
    const valor = String(formData.get("password") ?? "");
    startTransition(async () => {
      const r = await abrirMediaKitProtegido(slug, valor);
      if (r.status === "ok") {
        setSnapshot(r.snapshot);
        setError(null);
        return;
      }
      setError(textoDe(r));
    });
  }

  return (
    <form action={enviar} className="mx-auto max-w-sm py-16">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.description}</p>
      <div className="mt-6">
        <Field label={t.label} error={error ?? undefined} htmlFor="password">
          <span className="flex gap-2">
            <Input
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="off"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              invalid={Boolean(error)}
            />
            <Button onClick={() => setVisible((v) => !v)} aria-label={visible ? t.ocultarAria : t.mostrarAria}>
              {visible ? t.ocultar : t.mostrar}
            </Button>
          </span>
        </Field>
      </div>
      <div className="mt-4">
        <Button type="submit" variant="primary" loading={pending}>
          {t.enviar}
        </Button>
      </div>
    </form>
  );
}

/**
 * La hora en la zona de quien mira (no es la del workspace, es la de la
 * marca) y en el idioma de la frase que la rodea: una hora «3:15 PM»
 * dentro de una frase en español se leería mal. Formatea lib/format.ts.
 */
function textoBloqueo(hasta: string): string {
  const hora = formatTime(hasta, { locale: IDIOMA_MENSAJES, timeZone: browserTimeZone() });
  return MESSAGES.publico.kit.password.bloqueado(hora);
}

function textoDe(r: Exclude<AbrirKitResultado, { status: "ok" }>): string {
  const t = MESSAGES.publico.kit;
  switch (r.status) {
    case "password_invalid":
      return r.attemptsLeft > 0 && r.attemptsLeft <= 5 ? t.password.errorQuedan(r.attemptsLeft) : t.password.error;
    case "locked":
      return textoBloqueo(r.lockedUntil);
    case "too_many":
      return t.password.demasiados;
    case "expired":
      return t.vencido.description;
    case "error":
      return MESSAGES.publico.error.description;
    default:
      return MESSAGES.publico.noExiste.description;
  }
}
