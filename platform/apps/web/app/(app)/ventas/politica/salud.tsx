import type { AlertSignalCounts, RecentBounce } from "@mc/db/queries/entregabilidad";
import type { OutboundHealth } from "@mc/db/schema";
import { DataTable, CellMain } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

const TONO: Record<RecentBounce["kind"], "bad" | "warn" | "neutral"> = { hard: "bad", blocked: "warn", soft: "neutral" };

/**
 * «Salud de hoy»: adonde llevan las alertas diarias del outreach
 * (outbound.alerts). Las cifras de las últimas 24 horas, sacadas de
 * outbound_health (0037) y de readAlertSignalCounts (la misma consulta que
 * decide las alertas), y los últimos rebotes leídos del Gmail
 * (outbound_bounce, 0038). La pantalla no calcula nada: la tasa llega
 * hecha.
 */
export function Salud({
  health,
  counts,
  rebotes,
  f,
}: {
  health: OutboundHealth;
  counts: AlertSignalCounts;
  rebotes: RecentBounce[];
  f: Formatter;
}) {
  const t = MESSAGES.salud;
  return (
    <section id="salud" aria-labelledby="salud-titulo" className="mb-10 scroll-mt-8">
      <h2 id="salud-titulo" className="text-sm font-semibold">
        {t.title}
      </h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">{t.description}</p>

      <KpiRow className="mt-4">
        <Kpi label={t.enviados.label} value={f.int(counts.emailsSent)} note={t.enviados.note} />
        <Kpi
          label={t.rebotes.label}
          value={counts.hardBounceRate === null ? t.sinDato : f.pct(counts.hardBounceRate, 1)}
          note={
            counts.hardBounceRate === null
              ? t.rebotes.sinEnvios
              : t.rebotes.note(f.int(counts.hardBounces), f.int(counts.emailsSent))
          }
        />
        <Kpi
          label={t.cola.label}
          value={f.int(health.queue.due)}
          note={health.queue.stuck > 0 ? t.cola.note(f.int(health.queue.stuck)) : t.cola.noteSinAtascos}
        />
        <Kpi
          label={t.cuentas.label}
          value={f.int(health.accountsDown)}
          note={health.accountsDown > 0 ? t.cuentas.note : t.cuentas.noteBien}
        />
      </KpiRow>

      <h3 className="mt-6 text-sm font-medium">{t.rebotesTitle}</h3>
      <DataTable<RecentBounce>
        className="mt-2"
        caption={t.rebotesCaption}
        rows={rebotes}
        rowKey={(r) => r.id}
        density="compact"
        emptyState={<EmptyState title={t.sinRebotes.title} description={t.sinRebotes.description} />}
        columns={[
          {
            key: "direccion",
            header: t.columnas.direccion,
            render: (r) => <CellMain>{r.recipientAddress ?? t.sinDireccion}</CellMain>,
          },
          { key: "tipo", header: t.columnas.tipo, render: (r) => <Pill kind={TONO[r.kind]}>{t.tipos[r.kind]}</Pill> },
          {
            key: "motivo",
            header: t.columnas.motivo,
            render: (r) => <span className="line-clamp-2 break-words text-xs text-ink-2">{r.reason}</span>,
          },
          { key: "fecha", header: t.columnas.fecha, align: "num", render: (r) => f.dateTime(r.detectedAt) },
        ]}
      />
    </section>
  );
}
