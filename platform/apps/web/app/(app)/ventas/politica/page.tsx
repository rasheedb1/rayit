import type { Metadata } from "next";
import {
  getOutboundPolicy, HEALTH_WINDOW_H, listRecentBounces, POLICY_LIMITS, readAlertSignalCounts,
} from "@mc/db/queries/entregabilidad";
import { COMPANY_CAP_WINDOW_DAYS, outboundHealth } from "@mc/db/queries/outreach";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatTime, formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { PoliticaForm, type PoliticaFormProps } from "./form";
import { Interruptor } from "./interruptor";
import { MESSAGES } from "./messages";
import { Salud } from "./salud";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

/** Cuántos rebotes enseña «Salud de hoy». */
const REBOTES_VISIBLES = 8;

/**
 * /ventas/politica · la política de envío del outreach (VEN-15).
 *
 * El interruptor arriba, la salud del día (adonde llevan las alertas
 * diarias) y las reglas debajo, cada una con su línea de explicación
 * (referencia: los ajustes de límites y calentamiento de Lemlist e
 * Instantly). Lo que no es editable —el enlace de baja y el presupuesto
 * de redacción— se enseña, con el motivo, para que nadie lo busque.
 */
export default async function PoliticaPage() {
  const { policy, health, counts, rebotes } = await withWorkspace(async (tx) => ({
    policy: await getOutboundPolicy(tx),
    health: await outboundHealth(tx, HEALTH_WINDOW_H),
    counts: await readAlertSignalCounts(tx, tx.workspaceId, new Date()),
    rebotes: await listRecentBounces(tx, REBOTES_VISIBLES),
  }));
  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const t = MESSAGES;

  const campos = Object.keys(POLICY_LIMITS) as Array<keyof typeof POLICY_LIMITS>;
  const rangos = Object.fromEntries(
    campos.map((c) => [c, t.rango(f.int(POLICY_LIMITS[c].min), f.int(POLICY_LIMITS[c].max))]),
  ) as PoliticaFormProps["rangos"];
  const maximos = Object.fromEntries(campos.map((c) => [c, POLICY_LIMITS[c].max])) as PoliticaFormProps["maximos"];
  const minimos = Object.fromEntries(campos.map((c) => [c, POLICY_LIMITS[c].min])) as PoliticaFormProps["minimos"];
  // Las horas del horario de envío, por medias horas, con la etiqueta en el
  // idioma del espacio («9:00 a. m.»). Es una hora de reloj, no un instante:
  // se formatea en UTC para que ninguna zona la corra.
  const horas = Array.from({ length: 48 }, (_, i) => {
    const value = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;
    return { value, label: formatTime(`2000-01-03T${value}:00Z`, { locale: f.locale, timeZone: "UTC" }) };
  });

  const motivo =
    !policy.enabled && policy.disabledReason && policy.disabledAt
      ? t.interruptor.offReason(policy.disabledReason, f.date(policy.disabledAt, "long"))
      : null;

  return (
    <>
      <PageHeader
        eyebrow={t.header.eyebrow}
        title={t.header.title}
        description={t.header.description}
        aside={
          <Button variant="ghost" href="/ventas">
            {t.header.back}
          </Button>
        }
      />

      <Interruptor
        enabled={policy.enabled}
        hasAddress={Boolean(policy.postalAddress)}
        motivo={motivo}
        nuncaEncendido={!policy.enabled && policy.disabledAt === null}
      />

      <Salud health={health} counts={counts} rebotes={rebotes} f={f} />

      <PoliticaForm
        policy={policy}
        rangos={rangos}
        maximos={maximos}
        minimos={minimos}
        locale={f.locale}
        horas={horas}
        zona={f.zoneName()}
        ventanaMarca={f.int(COMPANY_CAP_WINDOW_DAYS)}
      />

      <section id="presupuesto" aria-labelledby="fijo-llm" className="mt-10 max-w-2xl scroll-mt-8 border-t border-line pt-6">
        <h2 id="fijo-llm" className="text-sm font-medium">
          {t.fijo.llm.label}
        </h2>
        <p className="mt-1 text-xs text-muted">{t.fijo.llm.body(f.money(policy.llmDailyCapUsd, "USD", { mode: "full" }))}</p>
        <p className="mt-4 text-xs text-fg-3">
          {policy.updatedAt && policy.saved ? t.actualizada(f.date(policy.updatedAt, "long")) : t.nuncaGuardada}
        </p>
      </section>
    </>
  );
}
