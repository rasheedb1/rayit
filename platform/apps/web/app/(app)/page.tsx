import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { STORIES } from "@/content/backlog";
import { PHASE2_MODULES, PRODUCT_MODULES, type ModuleDef } from "@/content/modules";
import { OWNERS, OWNER_IDS } from "@/content/team";
import { daysRange, formatDays, stats, storiesFor, storiesOf } from "@/lib/backlog";
import { Kpi } from "@/components/kpi";
import { OwnerAvatar, OwnerName } from "@/components/owner";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Progress, StatsList } from "@/components/progress";
import { SprintBoard } from "@/components/sprint-board";

export const metadata: Metadata = { title: "Plan" };

function ModuleCard({ m }: { m: ModuleDef }) {
  const st = stats(m.prefix ? storiesFor(m.prefix) : []);
  return (
    <Link
      href={`/${m.slug}`}
      className="group flex flex-col rounded-md border border-line bg-bg p-4 transition-colors hover:border-line-2 hover:bg-bg-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{m.name}</h3>
          <p className="mt-0.5 text-sm leading-5 text-fg-2">{m.summary}</p>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-fg-3 transition-colors group-hover:text-fg" aria-hidden="true" />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        {m.owner ? <OwnerName owner={m.owner} /> : <span className="text-sm text-fg-2">Los dos</span>}
        <span className="font-mono text-xs tabular-nums text-fg-3">
          {st.hecho}/{st.total} hechas
        </span>
      </div>
      <Progress stats={st} className="mt-2" />
    </Link>
  );
}

export default function PlanPage() {
  const all = stats(STORIES);
  const published = new Intl.DateTimeFormat("es-CO", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(new Date());

  return (
    <>
      <PageHeader
        eyebrow="MVP · fase 1"
        title="Plan de construcción"
        description="Seis módulos, dos personas, cinco sprints de dos semanas, más un sexto de fase 2. Cada módulo tiene un dueño y cada historia un estado; esta página se publica con cada merge a main."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Resumen del avance">
        <Kpi label="Historias" value={all.total} hint="En ocho grupos, seis sprints" />
        <Kpi label="Hechas" value={all.hecho} hint={`${Math.round(all.progress * 100)} % del MVP`} />
        <Kpi label="En curso" value={all.en_curso} hint={all.bloqueada ? `${all.bloqueada} bloqueadas` : "Ninguna bloqueada"} />
        <Kpi label="Pendientes" value={all.pendiente} hint="Sin empezar" />
      </section>

      <section className="mt-10" aria-labelledby="modulos">
        <SectionTitle meta="Cada uno es una ruta de esta app">
          <span id="modulos">Módulos del producto</span>
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PRODUCT_MODULES.map((m) => (
            <ModuleCard key={m.slug} m={m} />
          ))}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="personas">
        <SectionTitle meta="Corte por módulo completo, no por capa">
          <span id="personas">Por persona</span>
        </SectionTitle>
        <div className="grid gap-3 md:grid-cols-2">
          {OWNER_IDS.map((o) => {
            const list = storiesOf(o);
            const st = stats(list);
            const mods = PRODUCT_MODULES.filter((m) => m.owner === o);
            return (
              <div key={o} className="rounded-md border border-line p-4">
                <div className="flex items-start gap-3">
                  <OwnerAvatar owner={o} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{OWNERS[o].name}</p>
                    <p className="text-xs text-fg-3">{OWNERS[o].chain}</p>
                    <p className="mt-1 text-sm leading-5 text-fg-2">{OWNERS[o].focus}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {mods.map((m) => (
                    <Link key={m.slug} href={`/${m.slug}`} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-2 hover:border-line-2 hover:text-fg">
                      {m.name}
                    </Link>
                  ))}
                  <Link href="/cimientos" className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-2 hover:border-line-2 hover:text-fg">
                    Cimientos
                  </Link>
                  <Link href="/accesos" className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-2 hover:border-line-2 hover:text-fg">
                    Accesos
                  </Link>
                </div>
                <div className="mt-4 flex items-baseline justify-between">
                  <p className="text-xs text-fg-3">
                    {list.length} historias · {formatDays(daysRange(list))} estimados
                  </p>
                  <p className="font-mono text-xs tabular-nums text-fg-2">
                    {st.hecho}/{st.total}
                  </p>
                </div>
                <Progress stats={st} className="mt-2" />
                <div className="mt-3">
                  <StatsList stats={st} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="sprints">
        <SectionTitle meta="Diez días hábiles por persona y sprint">
          <span id="sprints">Sprints</span>
        </SectionTitle>
        <SprintBoard />
      </section>

      <section className="mt-10" aria-labelledby="fase2">
        <SectionTitle meta="Modelados en la base, apagados en la navegación">
          <span id="fase2">Fase 2</span>
        </SectionTitle>
        <ul className="flex flex-wrap gap-2">
          {PHASE2_MODULES.map((m) => (
            <li key={m.slug} className="rounded-md border border-dashed border-line px-3 py-1.5 text-sm text-fg-3" title={m.summary}>
              {m.name}
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 border-t border-line pt-4 text-xs text-fg-3">
        Publicado el {published}. El estado vive en apps/web/content/backlog.ts; el plan completo, en docs/backlog-mvp.md.
      </footer>
    </>
  );
}
