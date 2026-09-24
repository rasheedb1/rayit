"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { WARMUP_START_LIMIT, warmupCurve } from "@mc/core/outreach/warmup";
import type { OutboundPolicyView } from "@mc/db/queries/entregabilidad";
import { formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { guardarPolitica, type GuardarPoliticaState } from "./actions";
import { MESSAGES } from "./messages";

type Numerico = "maxTouchesPerCompany" | "minDaysBetweenTouches" | "maxEmailsPerDay" | "cooldownDaysAfterNo" | "warmupDays";
type SiNo = "si" | "no";

export interface PoliticaFormProps {
  policy: Pick<OutboundPolicyView, Numerico | "requireHumanReview" | "claimsMustBeSourced" | "postalAddress">;
  /** Los rangos de cada número, ya formateados («Entre 1 y 12.»). */
  rangos: Record<Numerico, string>;
  /** El tope de cada número, para el atributo max del control. */
  maximos: Record<Numerico, number>;
  /** El mínimo de cada número (POLICY_LIMITS): fuera de rango, la curva no se pinta. */
  minimos: Record<Numerico, number>;
  /** El locale del workspace, para las cifras de la curva. */
  locale: string;
}

const t = MESSAGES;

/** Lo que enseña el recuadro del calentamiento con lo que está escrito ahora. */
export type Calentamiento =
  | { tipo: "curva"; filas: Array<{ dia: string; correos: string }> }
  | { tipo: "sinCalentamiento" }
  | { tipo: "topeBajo"; texto: string }
  | { tipo: "fueraDeRango" };

/**
 * La curva sale de warmupCurve (@mc/core), la misma regla que usa el
 * despachador: la pantalla no repite ninguna condición. Si el tope o los
 * días están fuera de rango no se pinta nada engañoso («5.000 al día»).
 */
export function calentamientoDe(
  topeEscrito: string,
  diasEscritos: string,
  limites: { tope: { min: number; max: number }; dias: { min: number; max: number } },
  locale: string,
): Calentamiento {
  const tope = /^\d+$/.test(topeEscrito.trim()) ? Number(topeEscrito) : NaN;
  const dias = /^\d+$/.test(diasEscritos.trim()) ? Number(diasEscritos) : NaN;
  const dentro = (n: number, r: { min: number; max: number }) => Number.isInteger(n) && n >= r.min && n <= r.max;
  if (!dentro(tope, limites.tope) || !dentro(dias, limites.dias)) return { tipo: "fueraDeRango" };
  const curva = warmupCurve(tope, dias);
  if (curva.length > 0) {
    return {
      tipo: "curva",
      filas: curva.map((p) => ({
        dia: t.calentamiento.dia(formatInt(p.day, { locale })),
        correos: t.calentamiento.correos(formatInt(p.limit, { locale })),
      })),
    };
  }
  if (tope <= WARMUP_START_LIMIT && dias > 1) return { tipo: "topeBajo", texto: t.calentamiento.topeBajo(formatInt(tope, { locale })) };
  return { tipo: "sinCalentamiento" };
}

/**
 * La política editable. La validación de verdad es la de la acción (zod)
 * y la de la base (rangos y la dirección con el envío encendido); aquí
 * solo se pinta lo que devuelven, con el foco en el primer error.
 */
export function PoliticaForm({ policy, rangos, maximos, minimos, locale }: PoliticaFormProps) {
  const [state, formAction, pending] = useActionState<GuardarPoliticaState, FormData>(guardarPolitica, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [revision, setRevision] = useState<SiNo>(policy.requireHumanReview ? "si" : "no");
  const [cifras, setCifras] = useState<SiNo>(policy.claimsMustBeSourced ? "si" : "no");
  // Controlados: si el guardado falla, React 19 reinicia el formulario y
  // los valores escritos se perderían con defaultValue.
  const [valores, setValores] = useState<Record<Numerico, string>>({
    maxTouchesPerCompany: String(policy.maxTouchesPerCompany),
    minDaysBetweenTouches: String(policy.minDaysBetweenTouches),
    maxEmailsPerDay: String(policy.maxEmailsPerDay),
    cooldownDaysAfterNo: String(policy.cooldownDaysAfterNo),
    warmupDays: String(policy.warmupDays),
  });
  const [direccion, setDireccion] = useState(policy.postalAddress ?? "");
  const errors = state.errors ?? {};

  // La curva con la misma función que usa el despachador, con lo que está escrito ahora.
  const calentamiento = useMemo(
    () =>
      calentamientoDe(
        valores.maxEmailsPerDay,
        valores.warmupDays,
        {
          tope: { min: minimos.maxEmailsPerDay, max: maximos.maxEmailsPerDay },
          dias: { min: minimos.warmupDays, max: maximos.warmupDays },
        },
        locale,
      ),
    [valores.maxEmailsPerDay, valores.warmupDays, minimos, maximos, locale],
  );
  const ayudaDelCalentamiento = t.campos.warmupDays.help(formatInt(WARMUP_START_LIMIT, { locale }));
  const ayuda = (campo: Numerico) => (campo === "warmupDays" ? ayudaDelCalentamiento : t.campos[campo].help);

  useEffect(() => {
    if (!state.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const numero = (campo: Numerico) => (
    <Field
      label={t.campos[campo].label}
      help={`${ayuda(campo)} ${rangos[campo]}`}
      error={errors[campo]}
      htmlFor={campo}
      required
    >
      <Input
        id={campo}
        name={campo}
        inputMode="numeric"
        pattern="[0-9]*"
        value={valores[campo]}
        onChange={(e) => setValores((v) => ({ ...v, [campo]: e.target.value }))}
        max={maximos[campo]}
        className="max-w-32 tabular-nums"
        required
      />
    </Field>
  );

  const siNo = (campo: "requireHumanReview" | "claimsMustBeSourced", value: SiNo, set: (v: SiNo) => void) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink" id={`${campo}-label`}>
        {t.campos[campo].label}
      </span>
      <Segmented
        label={t.campos[campo].label}
        options={[
          { value: "si", label: t.si },
          { value: "no", label: t.no },
        ]}
        value={value}
        onChange={set}
        className="self-start"
      />
      <input type="hidden" name={campo} value={value} />
      <p className="text-xs text-muted">{t.campos[campo].help}</p>
    </div>
  );

  return (
    <form ref={formRef} action={formAction} noValidate className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-10">
        {state.message && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {state.message}
          </p>
        )}

        <section aria-labelledby="sec-ritmo" className="space-y-5">
          <h2 id="sec-ritmo" className="text-sm font-semibold">
            {t.secciones.ritmo}
          </h2>
          {numero("maxTouchesPerCompany")}
          {numero("minDaysBetweenTouches")}
          {numero("maxEmailsPerDay")}
          {numero("cooldownDaysAfterNo")}
        </section>

        <section aria-labelledby="sec-cuidado" className="space-y-5">
          <h2 id="sec-cuidado" className="text-sm font-semibold">
            {t.secciones.cuidado}
          </h2>
          {siNo("requireHumanReview", revision, setRevision)}
          {siNo("claimsMustBeSourced", cifras, setCifras)}
        </section>

        <section aria-labelledby="sec-cumplimiento" className="space-y-5">
          <h2 id="sec-cumplimiento" className="text-sm font-semibold">
            {t.secciones.cumplimiento}
          </h2>
          <Field
            label={t.campos.postalAddress.label}
            help={t.campos.postalAddress.help}
            error={errors.postalAddress}
            htmlFor="postalAddress"
          >
            <Textarea
              id="postalAddress"
              name="postalAddress"
              rows={2}
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              placeholder={t.campos.postalAddress.placeholder}
              maxLength={300}
            />
          </Field>
          <div>
            <p className="text-sm font-medium text-ink">{t.fijo.optout.label}</p>
            <p className="mt-1 text-xs text-muted">{t.fijo.optout.body}</p>
          </div>
        </section>

        <section aria-labelledby="sec-calentamiento" className="space-y-5">
          <h2 id="sec-calentamiento" className="text-sm font-semibold">
            {t.secciones.calentamiento}
          </h2>
          {numero("warmupDays")}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={pending}>
            {t.guardar}
          </Button>
          {state.ok && !pending && (
            <p role="status" className="text-sm text-good">
              {t.guardado}
            </p>
          )}
        </div>
      </div>

      <aside aria-labelledby="curva" className="lg:sticky lg:top-8 lg:self-start">
        <div className="rounded-md border border-line p-4">
          <p id="curva" className="text-sm font-medium">
            {t.calentamiento.title}
          </p>
          {calentamiento.tipo === "curva" ? (
            <table className="mt-3 w-full text-sm">
              <caption className="sr-only">{t.calentamiento.caption}</caption>
              <tbody>
                {calentamiento.filas.map((f) => (
                  <tr key={f.dia} className="border-b border-line last:border-b-0">
                    <th scope="row" className="py-1.5 text-left font-normal text-fg-2 tabular-nums">
                      {f.dia}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">{f.correos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-muted" aria-live="polite">
              {calentamiento.tipo === "topeBajo"
                ? calentamiento.texto
                : calentamiento.tipo === "fueraDeRango"
                  ? t.calentamiento.fueraDeRango
                  : t.calentamiento.sinCalentamiento}
            </p>
          )}
          <p className="mt-3 text-xs leading-4 text-fg-3">{ayudaDelCalentamiento}</p>
        </div>
      </aside>
    </form>
  );
}
