import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getResumenCoverage } from "@mc/db/queries/resumen";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { withWorkspace } from "@/lib/db";
import { Cifras, FiltroEnCurso } from "../filtro-en-curso";
import { Filtros } from "../filtros";
import { Frescura, FrescuraEsqueleto } from "../frescura";
import { Graficos, GraficosEsqueleto } from "../graficos";
import { Kpis, KpisEsqueleto } from "../kpis";
import { MESSAGES } from "../messages";
import { parseFiltro } from "../_lib/filtro";

export const metadata: Metadata = { title: MESSAGES.page.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Resumen: una sola página, el periodo arriba a la derecha y la
 * comparación con el periodo anterior en cada cifra (Vercel Analytics);
 * KPIs con sparkline (Stripe); nada que no sea el dato (Plausible); y
 * el número exacto en el tooltip (Linear Insights).
 *
 * Las dos consultas pesadas —KPIs y series— van en su propio Suspense:
 * la cabecera y los filtros se pintan de inmediato y cada bloque llega
 * cuando la base contesta, en vez de bloquear la página entera.
 */

/** Sin conexiones no hay ceros: hay dos caminos para empezar. */
function SinConexiones() {
  const t = MESSAGES.vacio.sinConexiones;
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState title={t.title} description={t.description} action={{ label: t.conectar, href: "/conexiones" }} />
      <p className="mt-3 text-center text-sm text-ink-2">
        <Link href="/resumen/importar" className="underline underline-offset-2 hover:text-ink">
          {t.importar}
        </Link>
      </p>
    </div>
  );
}

/** Conectadas pero sin lecturas: tampoco hay ceros que mostrar. */
function SinDatos() {
  const t = MESSAGES.vacio.sinDatos;
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState title={t.title} description={t.description} action={{ label: t.importar, href: "/resumen/importar" }} />
    </div>
  );
}

export default async function ResumenPage({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string; red?: string }>;
}) {
  const filtro = parseFiltro(await searchParams);
  const cobertura = await withWorkspace((tx) => getResumenCoverage(tx));
  const t = MESSAGES.page;

  return (
    // Una sola transición para los filtros y las cifras: mientras llega
    // el filtro nuevo, las cifras de antes se atenúan (filtro-en-curso.tsx).
    <FiltroEnCurso>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={cobertura.withData > 0 ? <Filtros filtro={filtro} /> : undefined}
      />

      {/* El plan de construcción no se enlaza aquí: es del equipo, no de la
          creadora que paga (pulido r8). Vive en /plan/resumen, desde el Plan. */}
      {cobertura.withData > 0 && (
        <div className="-mt-4 mb-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <Link href="/resumen/importar" className="underline-offset-2 hover:text-ink hover:underline">
            {t.importar}
          </Link>
        </div>
      )}

      {cobertura.connections === 0 ? (
        <SinConexiones />
      ) : cobertura.withData === 0 ? (
        <SinDatos />
      ) : (
        <Cifras>
          <Suspense fallback={<KpisEsqueleto />}>
            <Kpis filtro={filtro} />
          </Suspense>

          <div className="mt-4">
            <Suspense fallback={<GraficosEsqueleto />}>
              <Graficos filtro={filtro} />
            </Suspense>
          </div>

          {/*
            Frescura también es asíncrona: sin su propia frontera,
            su consulta bloquea el envío del documento y los dos
            esqueletos de arriba no llegan a verse nunca.
          */}
          <Suspense fallback={<FrescuraEsqueleto />}>
            <Frescura filtro={filtro} />
          </Suspense>
        </Cifras>
      )}
    </FiltroEnCurso>
  );
}
