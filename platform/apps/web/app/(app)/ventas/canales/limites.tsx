"use client";

import { useActionState } from "react";
import { Aviso } from "../../_lib/aviso";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { guardarLimites, type LimitesState } from "./actions";
import { MESSAGES } from "./messages";

/**
 * Los límites de una cuenta: por día y por semana. Vacío = sin límite
 * propio (manda la política del espacio). El máximo es el techo del
 * canal, que la base tampoco deja pasar. Los textos numéricos llegan ya
 * formateados desde el servidor con el locale del espacio.
 */
export function Limites({
  accountId, dailyCap, weeklyCap, maxDaily, maxWeekly, maxDailyText, maxWeeklyText, dailyPlaceholder,
}: {
  accountId: string;
  dailyCap: number | null;
  weeklyCap: number | null;
  maxDaily: number;
  maxWeekly: number;
  maxDailyText: string;
  maxWeeklyText: string;
  dailyPlaceholder: string;
}) {
  const [state, action, pending] = useActionState<LimitesState, FormData>(guardarLimites, {});
  const t = MESSAGES.caps;
  return (
    <form action={action} className="flex flex-col gap-3" aria-label={t.legend}>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="maxDaily" value={maxDailyText} />
      <input type="hidden" name="maxWeekly" value={maxWeeklyText} />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.daily} help={t.max(maxDailyText)} error={state.errors?.dailyCap}>
          <Input
            name="dailyCap" type="number" inputMode="numeric" min={0} max={maxDaily} step={1}
            defaultValue={dailyCap ?? ""} placeholder={dailyPlaceholder} className="tabular-nums"
          />
        </Field>
        <Field label={t.weekly} help={t.max(maxWeeklyText)} error={state.errors?.weeklyCap}>
          <Input
            name="weeklyCap" type="number" inputMode="numeric" min={0} max={maxWeekly} step={1}
            defaultValue={weeklyCap ?? ""} placeholder={t.placeholderNone} className="tabular-nums"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={pending}>
          {pending ? MESSAGES.actions.saving : MESSAGES.actions.saveCaps}
        </Button>
        <Aviso message={state.message} notice={state.notice} size="xs" />
      </div>
    </form>
  );
}
