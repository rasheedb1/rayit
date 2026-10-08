"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { cambiarCreadorNegocio } from "../../actions";
import { Aviso } from "../../../_lib/aviso";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * De qué creador es un negocio, en la ficha de su marca (ACC-7).
 *
 * Con alcance por creador, el creador decide quién ve el negocio: uno
 * «Sin creador» solo lo ve quien ve a todos, y un ejecutivo que lleva a
 * algunos creadores no sabía por qué le faltaban negocios. Aquí se dice,
 * y se cambia: «Cambiar creador» («Asignar creador» si no tiene) abre un
 * selector con los creadores que la persona puede poner
 * (listDealCreatorOptions) y, si ve a todos, «Sin creador». El texto
 * visible dice qué cambia porque en la misma tarjeta está el «Cambiar» de
 * la siguiente acción. Las reglas son de setDealCreator; esto solo las
 * pinta.
 *
 * El foco no se pierde: al abrir va al selector y al cerrar (Cancelar,
 * Escape o guardar) vuelve al botón, o al renglón del creador si el
 * botón ya no está, para que quien usa teclado o lector de pantalla siga
 * en el mismo negocio de la ficha.
 */
export function CreadorDelNegocio({
  dealId,
  dealName,
  companyId,
  creatorId,
  creatorName,
  creators,
  seesAll,
  canEdit,
}: {
  dealId: string;
  /** Para el nombre accesible del botón: «Cambiar de qué creador es "Serie Q4"». */
  dealName: string;
  companyId: string;
  creatorId: string | null;
  creatorName: string | null;
  /** Los creadores que esta persona puede poner (listDealCreatorOptions). */
  creators: ReadonlyArray<{ id: string; name: string }>;
  /** Si puede dejarlo «Sin creador». */
  seesAll: boolean;
  /** Si puede operar Ventas: quien solo mira ve el creador, no el botón. */
  canEdit: boolean;
}) {
  const t = MESSAGES.empresas.detail.dealCreator;
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const cambiarRef = useRef<HTMLSpanElement>(null);
  const renglonRef = useRef<HTMLDivElement>(null);
  /** Se cerró el formulario: el foco vuelve a donde estaba la persona. */
  const devolverFoco = useRef(false);
  const cerrar = () => {
    devolverFoco.current = true;
    setOpen(false);
  };
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(cambiarCreadorNegocio, (s) => {
    setNotice(s.notice);
    cerrar();
  });
  useEffect(() => {
    if (open || !devolverFoco.current) return;
    devolverFoco.current = false;
    (cambiarRef.current?.querySelector("button") ?? renglonRef.current)?.focus();
  }, [open]);
  const selectId = `creador-${dealId}`;
  const options = [
    ...(seesAll ? [{ value: "", label: t.none }] : []),
    ...creators.map((c) => ({ value: c.id, label: c.name })),
  ];
  // Solo se ofrece cambiar si hay a dónde: otra opción que no sea la de hoy.
  const editable = canEdit && options.some((o) => o.value !== (creatorId ?? ""));

  if (!open) {
    return (
      <div ref={renglonRef} tabIndex={-1} className="space-y-1 outline-none">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {/* Etiqueta y valor como la cabecera de la ficha («Responsable  Valentina Ortiz»): dt apagado, dd legible. */}
          <dl className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <dt className="text-muted">{t.label}</dt>
            <dd className="min-w-0 text-ink-2">
              {creatorName ?? t.none}
              {!creatorId && <span className="text-muted"> · {t.noneHelp}</span>}
            </dd>
          </dl>
          {editable && (
            // El Button del kit no reenvía ref: el foco vuelve buscando el botón dentro de este span.
            <span ref={cambiarRef} className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNotice(undefined);
                  setOpen(true);
                }}
                aria-label={creatorId ? t.changeLabel(dealName) : t.assignLabel(dealName)}
              >
                {creatorId ? t.change : t.assign}
              </Button>
            </span>
          )}
        </div>
        <Aviso notice={notice} size="xs" />
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      // Escape cierra el selector sin guardar, como Cancelar (y no mientras guarda).
      onKeyDown={(e) => {
        if (e.key !== "Escape" || pending) return;
        e.preventDefault();
        cerrar();
      }}
      noValidate
      aria-label={creatorId ? t.changeLabel(dealName) : t.assignLabel(dealName)}
      className="space-y-2"
    >
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="companyId" value={companyId} />
      <Field label={t.label} error={errors.creatorId} htmlFor={selectId}>
        <Select name="creatorId" defaultValue={creatorId ?? ""} options={options} autoFocus />
      </Field>
      <Aviso message={state.message} size="xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          {t.save}
        </Button>
        <Button variant="ghost" size="sm" onClick={cerrar} disabled={pending}>
          {MESSAGES.acciones.cancel}
        </Button>
      </div>
    </form>
  );
}
