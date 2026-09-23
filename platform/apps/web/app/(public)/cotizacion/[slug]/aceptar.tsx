"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { aceptarCotizacionPublica, type AceptarResultado } from "../../actions";

/**
 * «Aceptar cotización», con la firma mínima que piden Bonsai y
 * HoneyBook: nombre, correo y la casilla de términos. Un documento que
 * da pie a una factura necesita saber quién dijo que sí, y un clic
 * suelto no lo dice.
 *
 * La validación de verdad está en la Server Action (zod) y en la base
 * (public_quote_accept): aquí solo se pinta lo que devuelven.
 */
export function AceptarCotizacion({ slug }: { slug: string }) {
  const t = MESSAGES.publico.cotizacion;
  const id = useId();
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [terminos, setTerminos] = useState(false);
  const [resultado, setResultado] = useState<AceptarResultado | null>(null);
  const [pending, startTransition] = useTransition();

  if (resultado?.status === "ok") {
    return (
      <div role="status" className="rounded-md border border-good/30 bg-good-wash px-4 py-3">
        <p className="text-sm font-medium text-good">{t.graciasTitle}</p>
        <p className="mt-1 text-sm text-ink-2">{t.graciasDescription}</p>
      </div>
    );
  }

  const errores = resultado?.status === "invalid" ? resultado.errors : {};
  const general =
    resultado?.status === "no_existe"
      ? MESSAGES.publico.noExiste.description
      : resultado?.status === "no_aceptable"
        ? t.vencida
        : resultado?.status === "error"
          ? t.error
          : null;

  function aceptar() {
    startTransition(async () => {
      setResultado(await aceptarCotizacionPublica(slug, { name: nombre, email: correo, terminos }));
    });
  }

  return (
    <form
      className="space-y-4 rounded-md border border-border p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        aceptar();
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">{t.firma.title}</h2>
        <p className="mt-1 text-xs leading-4 text-muted">{t.firma.description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t.firma.nombre} required error={errores.name} htmlFor={`${id}-nombre`}>
          <Input autoComplete="name" value={nombre} maxLength={120} onChange={(e) => setNombre(e.target.value)} />
        </Field>
        <Field label={t.firma.correo} required error={errores.email} htmlFor={`${id}-correo`}>
          <Input type="email" autoComplete="email" value={correo} maxLength={254} onChange={(e) => setCorreo(e.target.value)} />
        </Field>
      </div>
      <div>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            checked={terminos}
            aria-invalid={errores.terminos ? true : undefined}
            aria-describedby={errores.terminos ? `${id}-terminos-error` : undefined}
            onChange={(e) => setTerminos(e.target.checked)}
          />
          <span>{t.firma.terminos}</span>
        </label>
        {errores.terminos && (
          <p id={`${id}-terminos-error`} role="alert" className="mt-1 text-xs text-bad">
            {errores.terminos}
          </p>
        )}
      </div>
      <Button type="submit" variant="primary" loading={pending}>
        {pending ? t.aceptando : t.aceptar}
      </Button>
      {general && (
        <p role="alert" className="text-sm text-bad">
          {general}
        </p>
      )}
    </form>
  );
}
