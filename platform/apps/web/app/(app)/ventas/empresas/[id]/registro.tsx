"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import type { LoggableActivityKind } from "@mc/db/queries/ventas-ficha";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Aviso } from "../../_componentes/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { registrarActividad } from "../actions";
import { FICHA } from "../messages";

/** Las teclas que eligen el tipo sin tocar el ratón, como en Superhuman. */
const TECLAS: Record<string, LoggableActivityKind> = { n: "note", l: "call", c: "email_sent", r: "meeting" };
const ORDEN: LoggableActivityKind[] = ["note", "call", "email_sent", "meeting"];

/** ¿El foco está en un sitio donde la letra se escribe? Entonces no es un atajo. */
function escribiendo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * El registro rápido de la ficha (VEN-5): nota, llamada, correo o
 * reunión, con el teclado de principio a fin.
 *
 *   · N, L, C o R (fuera de un campo) eligen el tipo y ponen el cursor en
 *     «Qué pasó».
 *   · ⌘ o Ctrl + Enter registra desde el texto.
 *
 * Una llamada, un correo o una reunión son hablar con la marca: mueven el
 * último contacto del negocio elegido o, si no se elige, de todos los
 * abiertos (lo decide logActivity en la base). Al registrar, el texto se
 * vacía, el tipo se queda y el aviso lo dice; la actividad aparece arriba
 * de la línea de tiempo cuando la ficha se revalida.
 */
export function RegistroRapido({
  companyId,
  deals,
  contacts,
  today,
}: {
  companyId: string;
  /** Los negocios de la empresa: los abiertos primero. */
  deals: { id: string; label: string; open: boolean }[];
  /** Los contactos a los que se les puede atribuir (los que no pidieron la baja). */
  contacts: { id: string; label: string }[];
  /** Hoy en la zona del espacio: el valor por defecto y el máximo de «Cuándo». */
  today: string;
}) {
  const t = FICHA.actividad;
  const [kind, setKind] = useState<LoggableActivityKind>("note");
  const [occurredOn, setOccurredOn] = useState(today);
  const [notice, setNotice] = useState<string | undefined>();
  const bodyId = `registro-${companyId}-body`;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(registrarActividad, (s) => {
    setNotice(s.notice);
    setOccurredOn(today);
  });

  const abiertos = deals.filter((d) => d.open);
  // Con un solo negocio abierto, la actividad es de ese. Con varios, la
  // persona elige; sin elegir, una llamada cuenta para todos los abiertos.
  const dealDefault = abiertos.length === 1 ? (abiertos[0]?.id ?? "") : "";

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || escribiendo(event.target)) return;
      const next = TECLAS[event.key.toLowerCase()];
      if (!next) return;
      event.preventDefault();
      setKind(next);
      document.getElementById(bodyId)?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bodyId]);

  function onBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        setNotice(undefined);
        onSubmit(e);
      }}
      noValidate
      aria-label={t.composerLabel}
      className="rounded-md border border-border bg-surface p-3"
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="occurredOn" value={occurredOn} />

      <Segmented
        label={t.kindLabel}
        size="sm"
        value={kind}
        onChange={setKind}
        options={ORDEN.map((k) => ({ value: k, label: FICHA.tiposManuales[k] }))}
      />

      <Field label={t.body} error={errors.body} required={kind === "note"} htmlFor={bodyId} className="mt-3">
        <Textarea
          name="body"
          rows={3}
          maxLength={4000}
          placeholder={t.bodyPlaceholder[kind]}
          onKeyDown={onBodyKeyDown}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        />
      </Field>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label={t.deal} help={kind === "note" ? undefined : t.dealHelp} error={errors.dealId} htmlFor={`registro-${companyId}-deal`}>
          <Select
            key={dealDefault}
            name="dealId"
            defaultValue={dealDefault}
            placeholder={kind === "note" || abiertos.length === 0 ? t.dealNone : t.dealAll}
            options={deals.map((d) => ({ value: d.id, label: d.label }))}
          />
        </Field>
        <Field label={t.contact} error={errors.contactId} htmlFor={`registro-${companyId}-contact`}>
          <Select name="contactId" defaultValue="" placeholder={t.contactNone} options={contacts.map((c) => ({ value: c.id, label: c.label }))} />
        </Field>
        <Field label={t.occurredOn} error={errors.occurredOn} htmlFor={`registro-${companyId}-date`}>
          <DateInput value={occurredOn} max={today} onChange={setOccurredOn} />
        </Field>
      </div>

      <Aviso message={state.message} notice={notice} className="mt-3" />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <span className="text-xs text-muted">{t.shortcut}</span>
        <span className="hidden text-xs text-muted sm:inline">{t.keys}</span>
      </div>
    </form>
  );
}
