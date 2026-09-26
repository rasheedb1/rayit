import {
  BOUNCE_MIN_ATTEMPTS, BOUNCE_RATE_THRESHOLD, bounceRateStatus, channelAccountLabel,
} from "@mc/core/outreach/deliverability";
import type {
  AlertSignalCounts, DownChannelAccount, OutreachAlertNotice, RecentBounce, SendReadiness,
} from "@mc/db/queries/entregabilidad";
import type { OutboundHealth } from "@mc/db/schema";
import { Button } from "@/components/ui/button";
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

/** El prefijo con el que VEN-9 guarda lo que Unipile dijo de una sesión ('unipile_status:CREDENTIALS'). */
const PREFIJO_SESION = "unipile_status:";
/** Lo que el worker deja en action_url para esta misma página: se enlaza solo el ancla, sin recargar. */
const ESTA_PAGINA = "/ventas/politica#";

/**
 * Qué le pasó a una cuenta caída, en frase. last_error guarda códigos
 * (CHANNEL_ERROR_CODES de VEN-9, 'unipile_status:<X>'); uno que no se
 * conoce, o una frase vieja con la jerga del proveedor, no se enseña
 * crudo: sale «No tenemos más detalle».
 */
export function motivoCaida(lastError: string | null, canal: string): string {
  const t = MESSAGES.salud.caidas;
  if (!lastError) return t.sinDetalle;
  if (lastError.startsWith(PREFIJO_SESION)) return t.motivoSesion(lastError.slice(PREFIJO_SESION.length), canal);
  if (lastError === "unipile_gone") return t.motivoSinCuenta(canal);
  return Object.hasOwn(t.motivos, lastError) ? (t.motivos[lastError] ?? t.sinDetalle) : t.sinDetalle;
}

/** El enlace de un aviso: si es de esta misma página, solo el ancla. */
function enlaceDeAviso(url: string): string {
  return url.startsWith(ESTA_PAGINA) ? url.slice(ESTA_PAGINA.length - 1) : url;
}

/**
 * «Salud de hoy»: adonde llevan las alertas diarias del outreach
 * (outbound.alerts). Las cifras de las últimas 24 horas, sacadas de
 * outbound_health (0046) y de readAlertSignalCounts (la misma consulta que
 * decide las alertas), y los últimos rebotes leídos del Gmail
 * (outbound_bounce, entregabilidad). La pantalla no calcula nada: la tasa llega
 * hecha.
 *
 * Si nadie está leyendo los rebotes de un Gmail conectado, lo dice encima
 * de la tabla: «Ningún rebote» no es «todo bien» si nadie los lee (r4).
 * Desde r5 lo decide el cursor de cada cuenta (readSendReadiness): 'never'
 * si un buzón no se leyó nunca (hasta integrar VEN-9), 'stale' si el job
 * se paró, con la hora de la última lectura. BOUNCE_READING_CONNECTED
 * (@mc/core) queda solo como interruptor del job. La fecha de cada rebote
 * va corta —la hora si es de hoy, el día y el mes si no—. En el móvil
 * (por debajo de sm) los rebotes van en una lista: la dirección y, debajo,
 * el tipo, la fecha y lo que dijo el servidor; la tabla de cuatro columnas
 * no cabe en 400 px y escondía la fecha tras un scroll interno.
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
  reconectarUrl = null,
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
  /**
   * Dónde se reconecta una cuenta (la pantalla de canales de VEN-9). Hasta
   * integrarla, null: sin botón, que no llevaría a ningún sitio.
   */
  reconectarUrl?: string | null;
}) {
  const t = MESSAGES.salud;
  const hayComoReconectar = Boolean(reconectarUrl || soporte);
  // «LinkedIn: Laura», sin repetir el canal si el nombre ya lo dice.
  const nombre = (c: DownChannelAccount) => channelAccountLabel(t.canal[c.channel], c.name);
  const cuales = new Intl.ListFormat(f.locale, { style: "long", type: "conjunction" }).format(caidas.map(nombre));
  const hoy = f.date(ahora);
  const cuando = (iso: string) => (f.date(iso) === hoy ? f.time(iso) : f.date(iso));
  // Dónde está la tasa respecto del aviso, con la regla del job (bounceRateStatus).
  const tasa = bounceRateStatus(counts);
  const umbral = f.pct(BOUNCE_RATE_THRESHOLD, 0);
  const detalleTasa =
    tasa === "too_few"
      ? t.rebotes.umbral.pocos(f.int(BOUNCE_MIN_ATTEMPTS))
      : tasa === "over"
        ? t.rebotes.umbral.sobre(umbral)
        : tasa === "under"
          ? t.rebotes.umbral.bajo(umbral)
          : null;
  // Con pocos envíos la tasa no dice nada (1 de 4 es un 25 %): la cifra
  // grande es la cuenta, «1 de 4», y la tasa sale solo con volumen (r5),
  // como en Instantly y Lemlist. La nota ya no repite la cuenta.
  // La tasa cuenta los duros y los bloqueos (readAlertSignalCounts): la nota dice cuántos de cada uno.
  const valorRebotes =
    counts.bounceRate === null
      ? t.sinDato
      : tasa === "too_few"
        ? t.rebotes.cuenta(f.int(counts.bounces), f.int(counts.emailsSent))
        : f.pct(counts.bounceRate, 1);
  const notaRebotes = [
    tasa === "too_few" ? null : t.rebotes.note(f.int(counts.hardBounces), f.int(counts.emailsSent), counts.hardBounces),
    counts.blockedBounces > 0 ? t.rebotes.bloqueados(f.int(counts.blockedBounces), counts.blockedBounces) : null,
    detalleTasa,
  ]
    .filter(Boolean)
    .join(" · ");
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
                  <span id={`aviso-${a.id}`} className="min-w-0 break-words text-sm font-medium">
                    {a.title}
                  </span>
                  <time dateTime={a.createdAt} title={f.dateTime(a.createdAt)} className="text-xs tabular-nums text-muted">
                    {cuando(a.createdAt)}
                  </time>
                </div>
                {a.body && <p className="mt-1 break-words text-xs text-ink-2">{a.body}</p>}
                {a.actionUrl && (
                  <a
                    href={enlaceDeAviso(a.actionUrl)}
                    aria-describedby={`aviso-${a.id}`}
                    className="mt-1 inline-block text-xs text-ink underline underline-offset-4 hover:text-ink-2"
                  >
                    {t.avisos.verPor[a.kind] ?? t.avisos.ver}
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
          value={valorRebotes}
          note={counts.bounceRate === null ? t.rebotes.sinEnvios : notaRebotes}
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

      {/* Adonde lleva la alerta outreach_account_down: cuál está caída, qué pasó (en frase, nunca el código) y qué hacer. */}
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
                  <p className="mt-1 break-words text-xs text-ink-2">{motivoCaida(c.lastError, t.canal[c.channel])}</p>
                  {/* El paso solo si hay cómo darlo: un botón o a quién escribir. Sin ninguno, pedirlo es un callejón (r5). */}
                  {hayComoReconectar && (
                    <p className="mt-1 text-xs text-ink">{c.channel === "email" ? t.caidas.paso.email : t.caidas.paso.otro}</p>
                  )}
                  {reconectarUrl && (
                    <Button
                      href={reconectarUrl}
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      aria-label={t.caidas.reconectarCuenta(nombre(c))}
                    >
                      {t.caidas.reconectar}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {!reconectarUrl && <p className="mt-3 text-xs text-ink-2">{t.caidas.donde(soporte)}</p>}
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
      {rebotes.length === 0 ? (
        <EmptyState className="mt-2" title={t.sinRebotes.title} description={t.sinRebotes.description} />
      ) : (
        <>
          {/* Móvil: una lista, sin scroll horizontal; la fecha no se esconde. */}
          <ul aria-label={t.rebotesCaption} className="mt-2 divide-y divide-line rounded-md border border-line sm:hidden">
            {rebotes.map((r) => (
              <li key={r.id} className="min-w-0 p-3">
                <p className="break-all text-sm font-medium text-ink">{r.recipientAddress ?? t.sinDireccion}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Pill kind={TONO[r.kind]}>{t.tipos[r.kind]}</Pill>
                  <time dateTime={r.detectedAt} title={f.dateTime(r.detectedAt)} className="text-xs tabular-nums text-muted">
                    {cuando(r.detectedAt)}
                  </time>
                </div>
                <p className="mt-1 line-clamp-2 break-words text-xs text-ink-2">{r.reason}</p>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
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
          </div>
        </>
      )}
    </section>
  );
}
