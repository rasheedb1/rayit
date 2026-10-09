import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccountAudience, getAccountMetricsHistory, isUuid, type AccountDayMetrics, type AccountMetricsHistory } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { ChartCard } from "@/components/ui/chart-card";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { accesoDe } from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";
import { Audiencia } from "./audiencia";

export const dynamic = "force-dynamic";

const t = MESSAGES.ficha;
const DIAS = 30;

function nombre(h: AccountMetricsHistory): string {
  return `@${h.handle ?? h.connectionId}`;
}

async function cargar(id: string) {
  if (!isUuid(id)) return null;
  return withWorkspace(async (tx) => {
    const historia = await getAccountMetricsHistory(tx, id, DIAS);
    if (!historia) return null;
    return { historia, audiencia: await getAccountAudience(tx, id) };
  });
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await requireModuleAccess("conexiones");
  const { id } = await params;
  const data = await cargar(id);
  return { title: data ? `${nombre(data.historia)} · ${MESSAGES.meta.title}` : MESSAGES.meta.title };
}

/** El último día con una cifra dada: las del día (vistas, alcance) pueden ir un día detrás de los seguidores. */
function ultimoCon<K extends keyof AccountDayMetrics>(days: AccountDayMetrics[], campo: K): AccountDayMetrics | undefined {
  for (let i = days.length - 1; i >= 0; i--) if (days[i]![campo] !== null) return days[i];
  return undefined;
}

/** La variación de seguidores frente a la lectura de hace siete días (o la más vieja si hay menos). */
function deltaSieteDias(days: AccountDayMetrics[]): number | undefined {
  const conSeguidores = days.filter((d) => d.followers !== null);
  const ultimo = conSeguidores.at(-1);
  if (!ultimo || conSeguidores.length < 2) return undefined;
  const objetivo = Date.parse(`${ultimo.day}T00:00:00Z`) - 7 * 86_400_000;
  const base = [...conSeguidores].reverse().find((d) => Date.parse(`${d.day}T00:00:00Z`) <= objetivo) ?? conSeguidores[0]!;
  if (base === ultimo || !base.followers) return undefined;
  return (ultimo.followers! - base.followers) / base.followers;
}

function Cifra({ etiqueta, dia, f, campo, days }: { etiqueta: string; dia?: AccountDayMetrics; f: Formatter; campo: keyof AccountDayMetrics; days: AccountDayMetrics[] }) {
  const d = dia ?? ultimoCon(days, campo);
  const v = d ? (d[campo] as number | null) : null;
  return <Kpi label={etiqueta} value={v === null ? t.sinDato : f.int(v)} note={d && v !== null ? f.date(d.day) : undefined} />;
}

export default async function FichaDeCuenta({ params }: { params: Promise<{ id: string }> }) {
  await requireModuleAccess("conexiones");
  const { id } = await params;
  const [data, ws] = await Promise.all([cargar(id), getCurrentWorkspace()]);
  if (!data) notFound();
  const { historia, audiencia } = data;
  const f = formatterFor(ws);
  const acceso = accesoDe(historia.accessMode);
  const days = historia.days;
  const ultimo = days.at(-1);
  const conVistas = days.some((d) => d.views !== null);

  const serie = {
    labels: days.map((d) => f.date(d.day)),
    axis: days.map((d) => f.dayMonth(d.day)),
    series: [
      { name: t.serie.seguidores, data: days.map((d) => d.followers ?? 0), color: "accent" as const },
      ...(conVistas ? [{ name: t.serie.vistas, data: days.map((d) => d.views ?? 0), color: historia.platformId as "instagram" | "tiktok" | "youtube" | "facebook" }] : []),
    ],
  };

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={nombre(historia)}
        description={acceso.conToken ? t.descripcion : t.descripcionPorArroba}
        aside={
          <Link href="/conexiones" className="text-sm text-accent underline underline-offset-2">
            ← {t.volver}
          </Link>
        }
      />
      <p className="-mt-6 mb-8 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <PlatformPill platformId={historia.platformId} />
        {historia.displayName && <span>{historia.displayName}</span>}
        {ultimo && <DataAsOf date={ultimo.day} opts={{ locale: f.locale, timeZone: f.timeZone }} />}
      </p>

      <section aria-labelledby="cifras">
        <SectionTitle>
          <span id="cifras">{t.kpis.titulo}</span>
        </SectionTitle>
        {days.length === 0 ? (
          <EmptyState title={t.serie.vacio} />
        ) : (
          <KpiRow>
            <Kpi
              label={t.kpis.seguidores}
              value={ultimo?.followers === null || ultimo === undefined ? t.sinDato : f.int(ultimo.followers)}
              delta={deltaSieteDias(days)}
              deltaLabel={t.kpis.vsSieteDias}
              sparkline={days.map((d) => d.followers ?? 0)}
            />
            <Cifra etiqueta={t.kpis.publicaciones} f={f} campo="mediaCount" days={days} />
            <Cifra etiqueta={t.kpis.vistas} f={f} campo="views" days={days} />
            <Cifra etiqueta={t.kpis.alcance} f={f} campo="reach" days={days} />
            <Cifra etiqueta={t.kpis.interacciones} f={f} campo="totalInteractions" days={days} />
            <Cifra etiqueta={t.kpis.visitasPerfil} f={f} campo="profileViews" days={days} />
          </KpiRow>
        )}
      </section>

      {days.length > 0 && (
        <div className="mt-8">
          <ChartCard
            title={t.serie.titulo}
            subtitle={t.serie.subtitulo}
            chart="line"
            series={serie.series}
            labels={serie.labels}
            labelsHeader={t.serie.fecha}
            format="int"
            axisFormat="compact"
            ariaLabel={t.serie.aria}
            asOf={ultimo ? { date: ultimo.day } : undefined}
            note={conVistas || acceso.conToken ? undefined : t.serie.soloSeguidores}
          />
        </div>
      )}

      {audiencia && <Audiencia audiencia={audiencia} autorizada={acceso.conToken} f={f} />}
    </>
  );
}
