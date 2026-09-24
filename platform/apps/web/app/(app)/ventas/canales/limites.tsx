"use client";

import { useActionState } from "react";
import { Aviso } from "../../_lib/aviso";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { guardarLimites, type LimitesState } from "./actions";
import { MESSAGES } from "./messages";

/**
 * Los límites de una cuenta: por día y por semana. Vacío = sin tope propio
 * (rige el máximo de la cuenta). El máximo lo calcula la base
 * (outreach_channel_account_limits) y lo comprueba el servidor al
 * guardar; aquí solo sirve para el `max` del campo y la ayuda, que llegan
 * ya formateadas con el locale del espacio. Nada de eso viaja de vuelta.
 */
export function Limites({
  accountId, dailyCap, weeklyCap, maxDaily, maxWeekly, dailyHelp, weeklyHelp, dailyPlaceholder, weeklyPlaceholder,
}: {
  accountId: string;
  dailyCap: number | null;
  weeklyCap: number | null;
  maxDaily: number;
  maxWeekly: number;
  dailyHelp: string;
  weeklyHelp: string;
  dailyPlaceholder: string;
  weeklyPlaceholder: string;
}) {
  const [state, action, pending] = useActionState<LimitesState, FormData>(guardarLimites, {});
  const t = MESSAGES.caps;
  return (
    <form action={action} className="flex flex-col gap-3" aria-label={t.legend}>
      <input type="hidden" name="accountId" value={accountId} />
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Field label={t.daily} help={dailyHelp} error={state.errors?.dailyCap}>
          <Input
            name="dailyCap" type="number" inputMode="numeric" min={0} max={maxDaily} step={1}
            defaultValue={dailyCap ?? ""} placeholder={dailyPlaceholder} className="w-28 tabular-nums"
          />
        </Field>
        <Field label={t.weekly} help={weeklyHelp} error={state.errors?.weeklyCap}>
          <Input
            name="weeklyCap" type="number" inputMode="numeric" min={0} max={maxWeekly} step={1}
            defaultValue={weeklyCap ?? ""} placeholder={weeklyPlaceholder} className="w-28 tabular-nums"
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
