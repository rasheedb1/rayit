"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input } from "@/components/ui/field";
import type { ActionState } from "@/lib/forms";
import { generarMediaKit } from "../actions";
import { MESSAGES } from "../messages";

/**
 * Generar un media kit: contraseña y vencimiento opcionales, como el
 * compartir de Notion. Las cifras no se eligen — se congelan las de hoy.
 *
 * La contraseña se escribe oculta, con un botón para verla: es la que
 * después se le dicta a la marca, así que hay que poder revisarla.
 */
export function GenerarMediaKitForm({ creatorId }: { creatorId: string }) {
  const t = MESSAGES.mediaKit;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(generarMediaKit, {});
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [expiresOn, setExpiresOn] = useState("");
  const errors = state.errors ?? {};

  return (
    <form action={formAction} className="min-w-0 rounded-md border border-border p-4">
      <input type="hidden" name="creatorId" value={creatorId} />
      <h2 className="text-sm font-semibold">{t.opciones.title}</h2>
      {state.message && (
        <p role="alert" className="mt-3 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {state.message}
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t.opciones.password} help={t.opciones.passwordAyuda} error={errors.password} htmlFor="mk-password">
          <span className="flex gap-2">
            <Input
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={120}
              placeholder={t.opciones.placeholder}
            />
            <Button
              size="md"
              variant="secondary"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? t.opciones.ocultarAria : t.opciones.mostrarAria}
            >
              {visible ? t.opciones.ocultar : t.opciones.mostrar}
            </Button>
          </span>
        </Field>
        <Field label={t.opciones.expira} help={t.opciones.expiraAyuda} error={errors.expiresOn} htmlFor="mk-expira">
          <DateInput name="expiresOn" value={expiresOn} onChange={setExpiresOn} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={pending}>
          {t.generar}
        </Button>
        {state.ok && (
          <span role="status" className="text-sm text-good">
            {t.generado}
          </span>
        )}
      </div>
    </form>
  );
}
