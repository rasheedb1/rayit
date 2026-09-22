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
 */
export function GenerarMediaKitForm({ creatorId }: { creatorId: string }) {
  const t = MESSAGES.mediaKit;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(generarMediaKit, {});
  const [password, setPassword] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const errors = state.errors ?? {};

  return (
    <form action={formAction} className="rounded-md border border-border p-4">
      <input type="hidden" name="creatorId" value={creatorId} />
      <h2 className="text-sm font-semibold">{t.opciones.title}</h2>
      {state.message && (
        <p role="alert" className="mt-3 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {state.message}
        </p>
      )}
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label={t.opciones.password} help={t.opciones.passwordAyuda} error={errors.password} htmlFor="password">
          <Input
            name="password"
            type="text"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={120}
            placeholder="opcional"
          />
        </Field>
        <Field label={t.opciones.expira} help={t.opciones.expiraAyuda} error={errors.expiresOn} htmlFor="expiresOn">
          <DateInput name="expiresOn" value={expiresOn} onChange={setExpiresOn} />
        </Field>
      </div>
      <div className="mt-4">
        <Button type="submit" variant="primary" loading={pending}>
          {t.generar}
        </Button>
      </div>
    </form>
  );
}
