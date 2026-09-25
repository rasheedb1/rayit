"use client";

import { Aviso } from "../../_lib/aviso";
import { useVentasForm } from "../_lib/use-ventas-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { guardarLimites } from "./actions";
import { MESSAGES } from "./messages";

/**
 * Los límites de una cuenta: por día y por semana. Vacío = sin tope propio
 * (rige el máximo de la cuenta). El máximo lo calcula la base
 * (outreach_channel_account_limits) y lo comprueba el servidor al
 * guardar, con las frases de messages.ts: el formulario va con noValidate
 * para que el navegador no conteste antes con su globo, en su idioma.
 *
 * Se envía con useVentasForm (el de todo Ventas) y no con `action={…}`:
 * React 19 vacía un formulario no controlado al terminar su acción,
 * también cuando vuelve con errores, y la persona vería «no puede pasar
 * del semanal» junto a un campo que ya no dice lo que escribió. Con el
 * hook, lo escrito se queda y el foco va al campo con el error.
 */
export function Limites({
  accountId, account, dailyCap, weeklyCap, dailyHelp, weeklyHelp, dailyPlaceholder, weeklyPlaceholder,
}: {
  accountId: string;
  /** El nombre de la cuenta, para el nombre accesible del formulario. */
  account: string;
  dailyCap: number | null;
  weeklyCap: number | null;
  dailyHelp: string;
  weeklyHelp: string;
  dailyPlaceholder: string;
  weeklyPlaceholder: string;
}) {
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(guardarLimites);
  const t = MESSAGES.caps;
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-3" aria-label={t.legend(account)}>
      <input type="hidden" name="accountId" value={accountId} />
      {/*
        * El ancho lo fija la rejilla, no el campo: el CONTROL del kit trae w-full
        * y un w-28 en el Input no hacía nada, así que cada campo medía lo que su
        * ayuda («Máximo 20 (política del espacio)») y cambiaba con el idioma. Dos
        * columnas iguales, de 10rem como mucho; la ayuda larga se parte debajo.
        */}
      <div className="grid max-w-[21.5rem] grid-cols-2 gap-x-6 gap-y-3" data-limites-rejilla>
        <Field label={t.daily} help={dailyHelp} error={errors["dailyCap"]} className="min-w-0">
          <Input
            name="dailyCap" type="number" inputMode="numeric" min={0} step={1}
            defaultValue={dailyCap ?? ""} placeholder={dailyPlaceholder} className="tabular-nums"
          />
        </Field>
        <Field label={t.weekly} help={weeklyHelp} error={errors["weeklyCap"]} className="min-w-0">
          <Input
            name="weeklyCap" type="number" inputMode="numeric" min={0} step={1}
            defaultValue={weeklyCap ?? ""} placeholder={weeklyPlaceholder} className="tabular-nums"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          {pending ? MESSAGES.actions.saving : MESSAGES.actions.saveCaps}
        </Button>
        <Aviso message={state.message} notice={state.notice} size="xs" />
      </div>
    </form>
  );
}
