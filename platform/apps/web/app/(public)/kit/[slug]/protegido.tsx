"use client";

import { useState, useTransition } from "react";
import type { PublicMediaKitResult } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { abrirMediaKitProtegido } from "../../actions";
import { MediaKitVista } from "./vista";

/**
 * El media kit con contraseña.
 *
 * La contraseña no va en la URL ni deja rastro en el historial: se
 * escribe aquí y viaja en el cuerpo de una Server Action, que la deriva
 * en el servidor y la compara contra el derivado guardado. Si acierta,
 * el snapshot vuelve ya recortado y se pinta con el mismo componente
 * que la versión abierta.
 */
export function MediaKitProtegido({ slug }: { slug: string }) {
  const t = MESSAGES.publico.kit.password;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<PublicMediaKitResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (resultado?.status === "ok") return <MediaKitVista snapshot={resultado.snapshot} />;

  function enviar(formData: FormData) {
    const valor = String(formData.get("password") ?? "");
    startTransition(async () => {
      const r = await abrirMediaKitProtegido(slug, valor);
      if (r.status === "ok") {
        setResultado(r);
        setError(null);
        return;
      }
      setError(r.status === "password_invalid" ? t.error : MESSAGES.publico.kit.noExiste.description);
    });
  }

  return (
    <form action={enviar} className="mx-auto max-w-sm py-16">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.description}</p>
      <div className="mt-6">
        <Field label={t.label} error={error ?? undefined} htmlFor="password">
          <Input
            name="password"
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            invalid={Boolean(error)}
          />
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
