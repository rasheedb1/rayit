"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Aviso } from "../../../_lib/aviso";
import { guardarPaso, type PasoCambios } from "../actions";
import { MESSAGES } from "../messages";
import type { PasoVista } from "./tarjeta-paso";

/** Los pasos que no llevan texto: la generación no aplica. */
const SIN_TEXTO = ["linkedin_like", "instagram_like", "manual_task"];

/**
 * La edición en línea de un paso, dentro de su tarjeta (referencia:
 * Linear, que edita en el sitio sin abrir otra pantalla). Con personas
 * dentro, el día y el tipo se ven pero no se cambian (`estructura`).
 */
export function EditorPaso({
  sequenceId,
  paso,
  estructura,
  angulos,
  tipos,
  onDone,
}: {
  sequenceId: string;
  paso: PasoVista;
  estructura: boolean;
  angulos: { value: string; label: string }[];
  tipos: { value: string; label: string }[];
  onDone: () => void;
}) {
  const t = MESSAGES.paso;
  const c = t.campos;
  const [tipo, setTipo] = useState(paso.stepType);
  const [modo, setModo] = useState(paso.generateWithAi ? "ai" : "fijo");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const sinTexto = SIN_TEXTO.includes(tipo);

  // Al abrir, el foco va al primer campo que se puede cambiar (con personas dentro, el día no).
  useEffect(() => formRef.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])")?.focus(), []);

  function enviar(form: FormData) {
    const texto = (k: string) => String(form.get(k) ?? "");
    const cambios: PasoCambios = {
      scheduledTime: texto("hora") || undefined,
      angleKey: texto("angulo") || null,
      guidanceEs: texto("guia"),
      generateWithAi: !sinTexto && modo === "ai",
      requiresAsset: (texto("activo") || null) as PasoCambios["requiresAsset"],
    };
    if (estructura) {
      cambios.dayOffset = Number(texto("dia"));
      cambios.stepType = tipo as PasoCambios["stepType"];
    }
    if (!sinTexto && modo === "fijo") {
      cambios.bodyTemplate = texto("cuerpo");
      if (tipo === "email") cambios.subjectTemplate = texto("asunto");
    }
    setError(undefined);
    start(async () => {
      const r = await guardarPaso(sequenceId, paso.id, cambios);
      if (r.error) setError(r.error);
      else onDone();
    });
  }

  return (
    <form
      ref={formRef}
      action={enviar}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
      aria-label={t.titulo(paso.numero)}
      className="grid gap-4 rounded-md border border-axis bg-surface p-3 sm:p-4"
    >
      <p className="text-sm font-semibold">{t.titulo(paso.numero)}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={c.dia} help={c.diaAyuda}>
          <Input
            name="dia"
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            defaultValue={paso.dayOffset}
            disabled={!estructura}
            className="tabular-nums"
          />
        </Field>
        <Field label={c.hora}>
          <Input name="hora" type="time" step={900} defaultValue={paso.scheduledTime} className="tabular-nums" />
        </Field>
        <Field label={c.tipo}>
          <Select name="tipo" options={tipos} value={tipo} onChange={(e) => setTipo(e.target.value)} disabled={!estructura} />
        </Field>
      </div>
      <Field label={c.angulo}>
        <Select name="angulo" options={[{ value: "", label: t.sinAngulo }, ...angulos]} defaultValue={paso.angleKey ?? ""} />
      </Field>
      <Field label={c.guia} help={c.guiaAyuda}>
        <Textarea name="guia" rows={4} maxLength={1000} defaultValue={paso.guia ?? ""} />
      </Field>
      {sinTexto ? (
        <p className="text-xs text-fg-3">{t.sinTexto}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={c.modo}>
            <Select
              name="modo"
              options={[
                { value: "ai", label: t.modos.ai },
                { value: "fijo", label: t.modos.fijo },
              ]}
              value={modo}
              onChange={(e) => setModo(e.target.value)}
            />
          </Field>
          <Field label={c.activo}>
            <Select
              name="activo"
              options={[
                { value: "", label: c.ninguno },
                { value: "media_kit", label: t.activo.media_kit! },
                { value: "quote", label: t.activo.quote! },
              ]}
              defaultValue={paso.requiresAsset ?? ""}
            />
          </Field>
        </div>
      )}
      {!sinTexto && modo === "fijo" && (
        <>
          {tipo === "email" && (
            <Field label={c.asunto}>
              <Input name="asunto" maxLength={200} defaultValue={paso.subjectTemplate ?? ""} />
            </Field>
          )}
          <Field label={c.cuerpo} help={c.cuerpoAyuda} required>
            <Textarea name="cuerpo" rows={6} maxLength={5000} defaultValue={paso.bodyTemplate ?? ""} required />
          </Field>
        </>
      )}
      <Aviso message={error} size="xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {MESSAGES.detalle.guardar}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {MESSAGES.detalle.cancelar}
        </Button>
      </div>
    </form>
  );
}
