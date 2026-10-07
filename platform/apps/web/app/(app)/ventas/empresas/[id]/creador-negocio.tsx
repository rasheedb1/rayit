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
 * y se cambia: «Cambiar» abre un selector con los creadores que la
 * persona puede poner (listDealCreatorOptions) y, si ve a todos, «Sin
 * creador». Las reglas son de setDealCreator; esto solo las pinta.
 *
 * El foco no se pierde: al abrir va al selector y al cerrar (Cancelar o
 * guardar) vuelve a «Cambiar», o al renglón del creador si el botón ya
 * no está, para que quien usa teclado o lector de pantalla siga en el
 * mismo negocio de la ficha.
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
  const cambiarRef = useRef<HTMLButtonElement>(null);
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
    (cambiarRef.current ?? renglonRef.current)?.focus();
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
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
          <span className="text-muted">{t.label}</span>
          <span className={creatorId ? "text-ink-2" : "text-muted"}>{creatorName ?? t.none}</span>
          {!creatorId && <span className="text-muted">· {t.noneHelp}</span>}
          {editable && (
            <button
              ref={cambiarRef}
              type="button"
              onClick={() => {
                setNotice(undefined);
                setOpen(true);
              }}
              aria-label={t.changeLabel(dealName)}
              className="text-ink underline underline-offset-4 hover:text-ink-2"
            >
              {t.change}
            </button>
          )}
        </p>
        <Aviso notice={notice} size="xs" />
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-label={t.changeLabel(dealName)} className="space-y-2">
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
