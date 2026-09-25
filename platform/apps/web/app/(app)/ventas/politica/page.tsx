import type { Metadata } from "next";
import {
  getOutboundPolicy, HEALTH_WINDOW_H, listRecentBounces, listTodayOutreachAlerts, POLICY_LIMITS, POSTAL_ADDRESS_MAX,
  readAlertSignalCounts, readSendReadiness,
} from "@mc/db/queries/entregabilidad";
import { COMPANY_CAP_WINDOW_DAYS, outboundHealth } from "@mc/db/queries/outreach";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatTime, formatterFor } from "@/lib/format";
import { correoDeSoporte } from "@/lib/soporte";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { PoliticaForm, type PoliticaFormProps } from "./form";
import { Interruptor } from "./interruptor";
import { MESSAGES } from "./messages";
import { puedeCambiarLaPolitica } from "./permiso";
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
  // Un solo «ahora» para las cifras de 24 horas y para saber qué rebote es de hoy.
  const ahora = new Date();
  const { policy, health, counts, rebotes, listo, avisos } = await withWorkspace(async (tx) => ({
    policy: await getOutboundPolicy(tx),
    health: await outboundHealth(tx, HEALTH_WINDOW_H),
    counts: await readAlertSignalCounts(tx, tx.workspaceId, ahora),
    rebotes: await listRecentBounces(tx, REBOTES_VISIBLES),
    listo: await readSendReadiness(tx),
    avisos: await listTodayOutreachAlerts(tx),
  }));
  const puedeCambiar = await puedeCambiarLaPolitica();
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

  // disabled_reason es un código ('manual'…, r4): se traduce aquí; uno desconocido va como detalle.
  const motivoTraducido = policy.disabledReason ? t.interruptor.motivos[policy.disabledReason] : undefined;
  const motivo =
    !policy.enabled && policy.disabledReason && policy.disabledAt
      ? motivoTraducido
        ? t.interruptor.offReason(motivoTraducido, f.date(policy.disabledAt, "long"))
        : t.interruptor.offReasonDetalle(policy.disabledReason, f.date(policy.disabledAt, "long"))
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
        puedeCambiar={puedeCambiar}
        cuentasConectadas={listo.connectedAccounts}
        aprobadosHoy={{ n: f.int(listo.approvedDueToday), cuantos: listo.approvedDueToday }}
      />

      <Salud
        avisos={avisos}
        health={health}
        counts={counts}
        rebotes={rebotes}
        caidas={listo.downAccounts}
        f={f}
        ahora={ahora.toISOString()}
        lectura={{ estado: listo.bouncesReading, desde: listo.bouncesReadAt }}
        soporte={correoDeSoporte()}
        // La pantalla de canales de VEN-9 (integrada en la fase 4), la misma
        // URL que CANALES_URL del worker: ahí está «Reconectar».
        reconectarUrl={OUTREACH_URLS.channels}
      />

      <PoliticaForm
        policy={policy}
        rangos={rangos}
        maximos={maximos}
        minimos={minimos}
        direccionMax={POSTAL_ADDRESS_MAX}
        locale={f.locale}
        horas={horas}
        zona={f.zoneName()}
        ventanaMarca={f.int(COMPANY_CAP_WINDOW_DAYS)}
        editable={puedeCambiar}
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
