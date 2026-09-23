import type { Metadata } from "next";
import { getOutboundPolicy, POLICY_LIMITS } from "@mc/db/queries/entregabilidad";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { PoliticaForm, type PoliticaFormProps } from "./form";
import { Interruptor } from "./interruptor";
import { MESSAGES } from "./messages";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

/**
 * /ventas/politica · la política de envío del outreach (VEN-15).
 *
 * El interruptor arriba y las reglas debajo, cada una con su línea de
 * explicación (referencia: los ajustes de límites y calentamiento de
 * Lemlist e Instantly). Lo que no es editable —el enlace de baja y el
 * presupuesto de redacción— se enseña, con el motivo, para que nadie lo
 * busque.
 */
export default async function PoliticaPage() {
  const policy = await withWorkspace((tx) => getOutboundPolicy(tx));
  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const t = MESSAGES;

  const campos = Object.keys(POLICY_LIMITS) as Array<keyof typeof POLICY_LIMITS>;
  const rangos = Object.fromEntries(
    campos.map((c) => [c, t.rango(f.int(POLICY_LIMITS[c].min), f.int(POLICY_LIMITS[c].max))]),
  ) as PoliticaFormProps["rangos"];
  const maximos = Object.fromEntries(campos.map((c) => [c, POLICY_LIMITS[c].max])) as PoliticaFormProps["maximos"];

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

      <Interruptor enabled={policy.enabled} hasAddress={Boolean(policy.postalAddress)} motivo={motivo} />

      <PoliticaForm policy={policy} rangos={rangos} maximos={maximos} locale={f.locale} />

      <section aria-labelledby="fijo-llm" className="mt-10 max-w-2xl border-t border-line pt-6">
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
