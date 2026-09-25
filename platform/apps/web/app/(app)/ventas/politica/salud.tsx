import { channelAccountLabel } from "@mc/core/outreach/deliverability";
import type {
  AlertSignalCounts, DownChannelAccount, OutreachAlertNotice, RecentBounce, SendReadiness,
} from "@mc/db/queries/entregabilidad";
import type { OutboundHealth } from "@mc/db/schema";
import { DataTable, CellMain } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

const TONO: Record<RecentBounce["kind"], "bad" | "warn" | "neutral"> = { hard: "bad", blocked: "warn", soft: "neutral" };
const TONO_AVISO: Record<OutreachAlertNotice["severity"], "bad" | "warn" | "neutral"> = {
  critical: "bad",
  warning: "warn",
  info: "neutral",
  success: "neutral",
};

/**
 * «Salud de hoy»: adonde llevan las alertas diarias del outreach
 * (outbound.alerts). Las cifras de las últimas 24 horas, sacadas de
 * outbound_health (0037) y de readAlertSignalCounts (la misma consulta que
 * decide las alertas), y los últimos rebotes leídos del Gmail
 * (outbound_bounce, 0038). La pantalla no calcula nada: la tasa llega
 * hecha.
 *
 * Si nadie está leyendo los rebotes de un Gmail conectado, lo dice encima
 * de la tabla: «Ningún rebote» no es «todo bien» si nadie los lee (r4).
 * Desde r5 lo decide el cursor de cada cuenta (readSendReadiness): 'never'
 * si un buzón no se leyó nunca (hasta integrar VEN-9), 'stale' si el job
 * se paró, con la hora de la última lectura. BOUNCE_READING_CONNECTED
 * (@mc/core) queda solo como interruptor del job. La fecha de cada rebote
 * va corta —la hora si es de hoy, el día y el mes si no— para que la
 * tabla quepa a 400 px.
 *
 * Arriba de todo, los avisos del día (listTodayOutreachAlerts): las
 * notification que deja outbound.alerts. La web no tiene campana, así que
 * este es el sitio donde un aviso se ve aunque el correo no esté
 * configurado o falle.
 */
export function Salud({
  avisos,
  health,
  counts,
  rebotes,
  caidas,
  f,
  ahora,
  lectura,
  soporte = null,
}: {
  /** Los avisos del outreach de las últimas 24 horas, los urgentes primero. */
  avisos: OutreachAlertNotice[];
  health: OutboundHealth;
  counts: AlertSignalCounts;
  rebotes: RecentBounce[];
  /** Las cuentas que piden reconectar o fallan (readSendReadiness): cuáles son, no solo cuántas. */
  caidas: DownChannelAccount[];
  f: Formatter;
  /** El instante de la página (ISO), para saber qué rebote es de hoy en la zona del workspace. */
  ahora: string;
  /** Si se leen los rebotes de los Gmail conectados (readSendReadiness), y la última lectura. */
  lectura: { estado: SendReadiness["bouncesReading"]; desde: string | null };
  /** SUPPORT_EMAIL: a quién escribir para reconectar una cuenta caída mientras no está la pantalla de canales. */
  soporte?: string | null;
}) {
  const t = MESSAGES.salud;
  // «LinkedIn: Laura», sin repetir el canal si el nombre ya lo dice.
  const nombre = (c: DownChannelAccount) => channelAccountLabel(t.canal[c.channel], c.name);
  const cuales = new Intl.ListFormat(f.locale, { style: "long", type: "conjunction" }).format(caidas.map(nombre));
  const hoy = f.date(ahora);
  const cuando = (iso: string) => (f.date(iso) === hoy ? f.time(iso) : f.date(iso));
  return (
    <section id="salud" aria-labelledby="salud-titulo" className="mb-10 scroll-mt-8">
      <h2 id="salud-titulo" className="text-sm font-semibold">
        {t.title}
      </h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">{t.description}</p>

      <section aria-labelledby="avisos-titulo" className="mt-4">
        <h3 id="avisos-titulo" className="text-sm font-medium">
          {t.avisos.title}
        </h3>
        {avisos.length === 0 ? (
          <EmptyState className="mt-2" title={t.avisos.vacio.title} description={t.avisos.vacio.description} />
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {avisos.map((a) => (
              <li key={a.id} className="min-w-0 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill kind={TONO_AVISO[a.severity]}>{t.avisos.severidad[a.severity]}</Pill>
                  <span className="min-w-0 break-words text-sm font-medium">{a.title}</span>
                  <time dateTime={a.createdAt} title={f.dateTime(a.createdAt)} className="text-xs tabular-nums text-muted">
                    {cuando(a.createdAt)}
                  </time>
                </div>
                {a.body && <p className="mt-1 break-words text-xs text-ink-2">{a.body}</p>}
                {a.actionUrl && (
                  <a href={a.actionUrl} className="mt-1 inline-block text-xs text-ink underline underline-offset-4 hover:text-ink-2">
                    {t.avisos.ver}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <KpiRow className="mt-6">
        <Kpi label={t.enviados.label} value={f.int(counts.emailsSent)} note={t.enviados.note} />
        <Kpi
          label={t.rebotes.label}
          value={counts.hardBounceRate === null ? t.sinDato : f.pct(counts.hardBounceRate, 1)}
          note={
            counts.hardBounceRate === null
              ? t.rebotes.sinEnvios
              : t.rebotes.note(f.int(counts.hardBounces), f.int(counts.emailsSent), counts.hardBounces)
          }
        />
        <Kpi
          label={t.cola.label}
          value={f.int(health.queue.due)}
          note={health.queue.stuck > 0 ? t.cola.note(f.int(health.queue.stuck), health.queue.stuck) : t.cola.noteSinAtascos}
        />
        <Kpi
          label={t.cuentas.label}
          value={f.int(health.accountsDown)}
          note={health.accountsDown > 0 && caidas.length ? t.cuentas.note(cuales) : t.cuentas.noteBien}
        />
      </KpiRow>

      {/* Adonde lleva la alerta outreach_account_down: cuál está caída, qué dijo el proveedor y qué hacer. */}
      <div id="cuentas" className="scroll-mt-8">
        {caidas.length > 0 && (
          <section aria-labelledby="cuentas-titulo" className="mt-6 rounded-md border border-warn/30 bg-warn-wash p-4">
            <h3 id="cuentas-titulo" className="text-sm font-medium">
              {t.caidas.title}
            </h3>
            <p className="mt-1 text-xs text-ink-2">{t.caidas.description}</p>
            <ul className="mt-3 space-y-3">
              {caidas.map((c) => (
                <li key={c.id} className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-words">{nombre(c)}</span>
                    <Pill kind={c.status === "error" ? "bad" : "warn"}>{t.caidas.estado[c.status]}</Pill>
                    {c.lastErrorAt && <span className="text-xs text-muted">{t.caidas.desde(f.date(c.lastErrorAt, "long"))}</span>}
                  </div>
                  <p className="mt-1 break-words text-xs text-ink-2">{c.lastError ?? t.caidas.sinDetalle}</p>
                  <p className="mt-1 text-xs text-ink">{c.channel === "email" ? t.caidas.paso.email : t.caidas.paso.otro}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-2">{t.caidas.donde(soporte)}</p>
          </section>
        )}
      </div>

      <h3 className="mt-6 text-sm font-medium">{t.rebotesTitle}</h3>
      {(lectura.estado === "never" || lectura.estado === "stale") && (
        <div role="note" className="mt-2 rounded-md border border-line bg-surface-2 p-3">
          <p className="text-sm font-medium">{t.lectura[lectura.estado].title}</p>
          <p className="mt-1 text-xs text-ink-2">
            {lectura.estado === "stale" && lectura.desde
              ? t.lectura.stale.description(f.dateTime(lectura.desde))
              : t.lectura.never.description}
          </p>
        </div>
      )}
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
          {
            key: "fecha",
            header: t.columnas.fecha,
            render: (r) => (
              <time dateTime={r.detectedAt} title={f.dateTime(r.detectedAt)} className="whitespace-nowrap text-xs tabular-nums">
                {cuando(r.detectedAt)}
              </time>
            ),
          },
        ]}
      />
    </section>
  );
}
