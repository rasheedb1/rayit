"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { aprobarMensaje } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * «Revisar y aprobar» un mensaje retenido de la cadencia (VEN-10): se
 * abre en su fila con el asunto (solo correo) y el texto a la vista y
 * editables, con el foco en el primero, y «Aprobar y enviar» lo devuelve
 * a la cola; al cerrar, el foco vuelve a «Revisar y aprobar». Lo que la base
 * rechaza (huecos sin rellenar, una nota demasiado larga) vuelve en el
 * campo del texto; lo demás, como aviso. Si falta la dirección postal, el
 * aviso trae el enlace a la política de envío, con el foco en él.
 *
 * Una respuesta en el hilo (email_reply) no tiene asunto propio: sale como
 * «Re: …» del correo anterior. En vez de un «Asunto» vacío que parece
 * obligatorio (y que, si se escribe, sustituye al del hilo), dice en qué
 * hilo responde y manda el asunto vacío.
 */
export function AprobarMensaje({
  companyId,
  touchId,
  persona,
  isEmail,
  isReply = false,
  threadSubject = null,
  subject,
  body,
}: {
  companyId: string;
  touchId: string;
  persona: string;
  isEmail: boolean;
  /** Una respuesta en el hilo (email_reply): sin campo de asunto. */
  isReply?: boolean;
  /** El asunto del hilo en el que responde (CadenceTouch.threadSubject). */
  threadSubject?: string | null;
  subject: string | null;
  body: string;
}) {
  const t = FICHA.cadencia;
  const [open, setOpen] = useState(false);
  // Al cerrar (o tras aprobar) el formulario se desmonta: el foco vuelve al
  // botón que lo abrió, y no cae en <body> a mitad de una tabla larga.
  const revisarRef = useRef<HTMLSpanElement>(null);
  const volver = useRef(false);
  const cerrar = () => {
    volver.current = true;
    setOpen(false);
  };
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(aprobarMensaje, cerrar);
  const id = `aprobar-${touchId}`;
  const conAsunto = isEmail && !isReply;
  // El enlace del aviso (la política de envío, si falta la dirección): el
  // foco va a él, que es lo siguiente que hay que hacer.
  const enlaceRef = useRef<HTMLAnchorElement>(null);
  const link = state.link;

  useEffect(() => {
    if (!open && volver.current) {
      volver.current = false;
      revisarRef.current?.querySelector("button")?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (link) enlaceRef.current?.focus();
  }, [link]);

  if (!open) {
    return (
      <div className="grid gap-2">
        <span ref={revisarRef} className="inline-flex">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={t.revisarLabel(persona)}>
            {t.revisar}
          </Button>
        </span>
        <Aviso message={state.message} notice={state.notice} />
      </div>
    );
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-3" aria-label={t.revisarLabel(persona)}>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="touchId" value={touchId} />
      {conAsunto ? (
        <Field label={t.asunto} htmlFor={`${id}-subject`} error={errors.subject}>
          <Input name="subject" defaultValue={subject ?? ""} autoFocus />
        </Field>
      ) : (
        <input type="hidden" name="subject" value="" />
      )}
      {isEmail && isReply && (
        <p className="text-sm text-ink-2">{threadSubject ? t.enHilo(threadSubject) : t.enHiloSinAsunto}</p>
      )}
      <Field label={t.texto} help={t.textoHelp} htmlFor={`${id}-body`} error={errors.body}>
        <Textarea name="body" rows={5} defaultValue={body} autoFocus={!conAsunto} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {t.aprobar}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={cerrar}>
          {t.cerrar}
        </Button>
      </div>
      <Aviso message={state.message} notice={state.notice} />
      {link && (
        <Link ref={enlaceRef} href={link.href} className="text-sm text-ink underline underline-offset-4 hover:text-ink-2">
          {link.label}
        </Link>
      )}
    </form>
  );
}
