"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { fijarSiguienteAccion, marcarHecha } from "../empresas/actions";
import { FICHA } from "../empresas/messages";
import { Aviso } from "../_componentes/aviso";
import { MESSAGES } from "../_lib/messages";
import { useVentasForm } from "../_lib/use-ventas-form";
import type { SeguimientoContexto, SiguienteAccionData } from "./datos";

/**
 * La siguiente acción de un negocio en UNA línea —qué, cuándo y quién—,
 * editable en su sitio (VEN-4). Como Linear: se lee de un vistazo y se
 * cambia sin salir de la pantalla. La montan la ficha de empresa, el
 * tablero, la lista del pipeline y «Para hoy».
 *
 *   · «Cambiar» abre el formulario en su sitio: Enter guarda, Esc cancela.
 *   · «Hecha» deja la acción en la historia del negocio y abre el
 *     formulario para la siguiente, que se propone para mañana.
 *   · Sin acción, la línea lo dice en ámbar («Sin siguiente acción») con
 *     el botón para ponerla: un negocio sin siguiente acción se enfría.
 *
 * `compact` apila los campos: la tarjeta del tablero mide 256 px.
 * `onEditingChange` avisa al tablero para que la tarjeta deje de ser
 * arrastrable mientras se escribe (si no, seleccionar texto la arrastra).
 */
export function SiguienteAccion({
  data,
  ctx,
  compact = false,
  onEditingChange,
}: {
  data: SiguienteAccionData;
  ctx: SeguimientoContexto;
  compact?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const t = FICHA.siguiente;
  const [editing, setEditingState] = useState(false);
  /** Se abrió tras «Hecha»: la acción empieza vacía y el día, mañana. */
  const [afterDone, setAfterDone] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  /** Al cerrar el formulario, el foco vuelve a la línea y no cae en <body>. */
  const [refocus, setRefocus] = useState(false);
  const lineRef = useRef<HTMLDivElement>(null);
  const setEditing = (v: boolean) => {
    setEditingState(v);
    if (!v) setRefocus(true);
    onEditingChange?.(v);
  };

  useEffect(() => {
    if (editing || !refocus) return;
    lineRef.current?.querySelector<HTMLElement>("button")?.focus();
    setRefocus(false);
  }, [editing, refocus]);

  const hecha = useVentasForm(marcarHecha, (s) => {
    setNotice(s.notice);
    setAfterDone(true);
    setEditing(true);
  });

  if (editing) {
    return (
      <Editor
        data={data}
        ctx={ctx}
        compact={compact}
        blank={afterDone}
        notice={afterDone ? notice : undefined}
        onDone={(msg) => {
          setNotice(msg);
          setAfterDone(false);
          setEditing(false);
        }}
        onCancel={() => {
          setAfterDone(false);
          setNotice(undefined);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div ref={lineRef} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5">
        {data.due && <Pill kind={data.due.kind}>{data.due.text}</Pill>}
        {data.action ? (
          <span className="min-w-0 break-words text-ink">{data.action}</span>
        ) : (
          <span className="text-warn">{t.none}</span>
        )}
        {data.action && data.dueText && <span className="whitespace-nowrap tabular-nums text-muted">· {data.dueText}</span>}
        {data.action && data.responsibleName && <span className="text-muted">· {data.responsibleName}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant={data.action ? "ghost" : "secondary"}
          onClick={() => {
            setNotice(undefined);
            setAfterDone(false);
            setEditing(true);
          }}
          aria-label={data.action ? t.editLabel(data.dealLabel) : t.setLabel(data.dealLabel)}
        >
          {data.action ? t.edit : t.set}
        </Button>
        {data.action && (
          <form ref={hecha.formRef} onSubmit={hecha.onSubmit} noValidate>
            <input type="hidden" name="dealId" value={data.dealId} />
            <Button type="submit" size="sm" variant="ghost" loading={hecha.pending} aria-label={t.doneLabel(data.action)}>
              {t.done}
            </Button>
          </form>
        )}
      </div>
      <Aviso message={hecha.state.message} notice={notice} className="mt-2 text-xs" />
    </div>
  );
}

function Editor({
  data,
  ctx,
  compact,
  blank,
  notice,
  onDone,
  onCancel,
}: {
  data: SiguienteAccionData;
  ctx: SeguimientoContexto;
  compact: boolean;
  blank: boolean;
  notice?: string;
  onDone: (notice?: string) => void;
  onCancel: () => void;
}) {
  const t = FICHA.siguiente;
  const [dueDate, setDueDate] = useState(blank ? ctx.tomorrow : data.form.dueDate);
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(fijarSiguienteAccion, (s) => onDone(s.notice));
  const id = (campo: string) => `siguiente-${data.dealId}-${campo}`;
  const ownerOptions = ctx.owners.map((o) => ({ value: o.userId, label: o.label }));

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      noValidate
      aria-label={t.formLabel(data.dealLabel)}
      className="rounded-md border border-border bg-surface-2 p-3"
    >
      <input type="hidden" name="dealId" value={data.dealId} />
      <input type="hidden" name="dueDate" value={dueDate} />
      {notice && <Aviso notice={notice} className="mb-3 text-xs" />}
      <div className={`grid gap-3 ${compact ? "" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)]"}`}>
        <Field label={t.action} error={errors.action} required htmlFor={id("action")}>
          <Input
            name="action"
            autoFocus
            maxLength={200}
            autoComplete="off"
            placeholder={t.actionPlaceholder}
            defaultValue={blank ? "" : (data.action ?? "")}
          />
        </Field>
        <Field label={t.dueDate} error={errors.dueDate} required htmlFor={id("date")}>
          <DateInput value={dueDate} min={ctx.today} onChange={setDueDate} />
        </Field>
        <Field label={t.dueTime} help={compact ? undefined : t.dueTimeHelp} error={errors.dueTime} htmlFor={id("time")}>
          <Input name="dueTime" type="time" defaultValue={data.form.dueTime} className="tabular-nums" />
        </Field>
        <Field label={t.responsible} error={errors.responsibleUserId} htmlFor={id("who")}>
          <Select name="responsibleUserId" defaultValue={data.form.responsibleUserId} placeholder={t.noResponsible} options={ownerOptions} />
        </Field>
      </div>
      <Aviso message={state.message} className="mt-3 text-xs" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.save}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {MESSAGES.acciones.cancel}
        </Button>
        <span className="text-xs text-muted">{t.shortcut}</span>
      </div>
    </form>
  );
}
