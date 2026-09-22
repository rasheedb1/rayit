"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Textarea } from "@/components/ui/field";
import { editarCampana, type AccionState } from "./actions";

/**
 * Edición inline: un botón «Editar» abre el formulario en el sitio; al
 * guardar bien se cierra y la ficha se revalida. Solo viajan los campos
 * del formulario; el resto se conserva. Los errores por campo vienen
 * del servidor (zod), en español.
 */
function useEditar(onSaved: () => void) {
  const [state, formAction, pending] = useActionState<AccionState, FormData>(editarCampana, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) onSaved();
    else if (state.errors) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    // onSaved cambia en cada render del padre; solo importa cuando cambia state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return { state, formAction, pending, formRef };
}

function Marco({
  open,
  setOpen,
  title,
  children,
  message,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  title: string;
  children: React.ReactNode;
  message?: string;
}) {
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3" role="group" aria-label={title}>
      {message && (
        <p role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {message}
        </p>
      )}
      {children}
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="primary" size="sm">
          Guardar
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

export function SeguimientoForm({ campaignId, trackingCode, trackingUrl }: { campaignId: string; trackingCode: string | null; trackingUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending, formRef } = useEditar(() => setOpen(false));
  const errors = state.errors ?? {};
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        {trackingCode || trackingUrl ? "Editar seguimiento" : "Agregar seguimiento"}
      </Button>
    );
  }
  return (
    <form ref={formRef} action={formAction} noValidate aria-busy={pending || undefined}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <Marco open={open} setOpen={setOpen} title="Editar seguimiento" message={state.message}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Código" help="El que la marca reconoce en sus canjes, como LAURA15." error={errors.trackingCode} htmlFor="trackingCode">
            <Input name="trackingCode" defaultValue={trackingCode ?? ""} maxLength={40} autoComplete="off" />
          </Field>
          <Field label="Enlace rastreado" help="Con sus UTM. Vacío para quitarlo." error={errors.trackingUrl} htmlFor="trackingUrl">
            <Input name="trackingUrl" type="url" inputMode="url" defaultValue={trackingUrl ?? ""} maxLength={500} placeholder="https://" />
          </Field>
        </div>
      </Marco>
    </form>
  );
}

export function DatosForm({
  campaignId,
  name,
  startsOn,
  endsOn,
  brief,
}: {
  campaignId: string;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  brief: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { state, formAction, pending, formRef } = useEditar(() => setOpen(false));
  const errors = state.errors ?? {};
  const [starts, setStarts] = useState(startsOn ?? "");
  const [ends, setEnds] = useState(endsOn ?? "");
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Editar datos
      </Button>
    );
  }
  return (
    <form ref={formRef} action={formAction} noValidate aria-busy={pending || undefined}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <Marco open={open} setOpen={setOpen} title="Editar datos" message={state.message}>
        <div className="grid gap-3">
          <Field label="Nombre" required error={errors.name} htmlFor="name">
            <Input name="name" defaultValue={name} maxLength={120} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Inicio" error={errors.startsOn} htmlFor="startsOn">
              <DateInput name="startsOn" value={starts} onChange={setStarts} />
            </Field>
            <Field label="Fin" error={errors.endsOn} htmlFor="endsOn">
              <DateInput name="endsOn" value={ends} min={starts || undefined} onChange={setEnds} />
            </Field>
          </div>
          <Field label="Brief" help="Lo que se acordó, en texto. Vacío para quitarlo." error={errors.brief} htmlFor="brief">
            <Textarea name="brief" defaultValue={brief ?? ""} maxLength={2000} rows={3} />
          </Field>
        </div>
      </Marco>
    </form>
  );
}
