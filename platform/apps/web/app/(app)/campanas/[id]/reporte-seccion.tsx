import { canGenerateReport, REPORT_STATUS_META, type CampaignStatus } from "@mc/core";
import type { CampaignReportRow } from "@mc/db";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { generarReporte, marcarReporteEnviado } from "./actions";
import { CopyButton } from "./copiar";
import { TransitionButton } from "./transicion";

const t = MESSAGES.reporte;

export interface ReporteSeccionProps {
  campaignId: string;
  status: CampaignStatus;
  /** Las versiones, la más reciente primero (listCampaignReports). */
  reports: CampaignReportRow[];
  /**
   * El origen público de la aplicación (lib/auth/origen.ts: APP_URL en
   * producción). null si no se pudo resolver: entonces se muestra la
   * ruta y la frase que lo explica, nunca un enlace a localhost.
   */
  origin: string | null;
  f: Formatter;
}

/**
 * «Reporte a la marca» en la ficha (CAM-6): generar, previsualizar,
 * copiar el enlace, marcar enviado por enlace o como PDF, el estado con
 * sus fechas y las versiones. Solo props: lo que pinta lo trae la
 * página en su transacción.
 */
export function ReporteSeccion({ campaignId, status, reports, origin, f }: ReporteSeccionProps) {
  const disponible = canGenerateReport(status);
  const ultimo = reports[0] ?? null;

  if (!disponible && !ultimo) {
    return <EmptyState title={t.title} description={status === "cancelled" ? t.noDisponible.cancelled : t.noDisponible.planned} />;
  }

  const ayuda = !ultimo ? t.ayudaSinReporte : ultimo.status === "draft" ? t.ayudaBorrador : t.ayudaEnviado;
  const generar = disponible ? (
    <div className="flex flex-col gap-1.5">
      {ultimo ? (
        <TransitionButton
          action={generarReporte.bind(null, campaignId)}
          label={t.regenerar}
          confirmText={ultimo.status === "draft" ? t.confirmarRegenerar : t.confirmarNuevaVersion}
        />
      ) : (
        <form action={generarReporte.bind(null, campaignId)}>
          <Button type="submit" variant="primary">
            {t.generar}
          </Button>
        </form>
      )}
      <p className="text-xs text-fg-3">{ayuda}</p>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      {ultimo && <VersionActual campaignId={campaignId} r={ultimo} origin={origin} f={f} publicable={disponible} />}
      {generar}
      {reports.length > 1 && (
        <div>
          <h3 className="text-xs font-medium text-fg-3">{t.versiones}</h3>
          <ol className="mt-2 divide-y divide-line rounded-md border border-line">
            {reports.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{t.version(reports.length - i)}</span>
                  <span className="text-fg-3"> · {t.generado(f.dateTime(r.createdAt))}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Pill kind={REPORT_STATUS_META[r.status].kind}>{REPORT_STATUS_META[r.status].label}</Pill>
                  {r.supersededById ? <span className="text-xs text-fg-3">{t.versionReemplazada}</span> : null}
                  <Button size="sm" variant="ghost" href={`/campanas/${campaignId}/reporte/${r.id}`}>
                    {t.previsualizar}
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function VersionActual({
  campaignId,
  r,
  origin,
  f,
  publicable,
}: {
  campaignId: string;
  r: CampaignReportRow;
  origin: string | null;
  f: Formatter;
  /** La campaña sigue admitiendo reporte: una cancelada después de generar no publica su borrador. */
  publicable: boolean;
}) {
  const meta = REPORT_STATUS_META[r.status];
  const ruta = `/reporte/${r.slug}`;
  const enlace = origin ? `${origin}${ruta}` : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill kind={meta.kind}>{meta.label}</Pill>
        <Button size="sm" variant="ghost" href={`/campanas/${campaignId}/reporte/${r.id}`}>
          {t.previsualizar}
        </Button>
      </div>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="sr-only">{t.estado}</dt>
          <dd className="text-fg-2">{t.generado(f.dateTime(r.createdAt))}</dd>
        </div>
        {r.sentAt && r.sentVia ? (
          <div>
            <dt className="sr-only">{t.estado}</dt>
            <dd className="text-fg-2">{t.enviado(r.sentVia, f.dateTime(r.sentAt))}</dd>
          </div>
        ) : null}
        {r.status !== "draft" ? (
          <div>
            <dt className="sr-only">{t.estado}</dt>
            <dd className="text-fg-2">
              {r.viewedAt ? `${t.visto(f.dateTime(r.viewedAt))} · ${t.visitas(r.viewCount)}` : t.sinAbrir}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="min-w-0">
        <p className="text-xs text-fg-3">{t.enlace}</p>
        {enlace ? (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <code className="min-w-0 max-w-full break-all font-mono text-xs">{enlace}</code>
            <CopyButton value={enlace} label={t.copiarEnlace} />
          </span>
        ) : (
          <p className="mt-1 text-xs text-fg-3">
            <code className="break-all font-mono">{ruta}</code> · <span>{t.sinOrigen}</span>
          </p>
        )}
        {r.status === "draft" && <p className="mt-1 text-xs text-fg-3">{t.enlaceBorrador}</p>}
      </div>

      {r.status === "draft" && publicable && (
        <div className="flex flex-wrap gap-2">
          <TransitionButton
            action={marcarReporteEnviado.bind(null, campaignId, r.id, "link")}
            label={t.marcarEnlace}
            confirmText={t.confirmarEnviado("link")}
            variant="primary"
          />
          <TransitionButton
            action={marcarReporteEnviado.bind(null, campaignId, r.id, "pdf")}
            label={t.marcarPdf}
            confirmText={t.confirmarEnviado("pdf")}
          />
        </div>
      )}
    </div>
  );
}
