import Link from "next/link";
import { listOwnerOptions } from "@mc/db/queries/ventas";
import { getLocalDates, listDueToday } from "@mc/db/queries/ventas-ficha";
import { SectionTitle } from "@/components/page-header";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { FICHA } from "../empresas/messages";
import { withWorkspace } from "../_lib/db";
import { opcionesDeResponsable, siguienteAccionData, type SeguimientoContexto } from "./datos";
import { SiguienteAccion } from "./siguiente-accion";

/** Cuántos seguimientos enseña el bloque; el resto se ve en el pipeline. */
const LIMITE = 6;

/**
 * «Para hoy», arriba de /ventas (VEN-4): los negocios abiertos cuya
 * siguiente acción ya venció o vence hoy en la zona del espacio, primero
 * lo más vencido, cada uno con su línea editable («Hecha», «Cambiar»).
 * Debajo, cuántos negocios abiertos no tienen siguiente acción, con el
 * enlace al pipeline, donde se ven marcados.
 *
 * Se monta con una línea (`<ParaHoy />`): lee lo suyo en su propia
 * transacción. Sin nada vencido, nada para hoy y nada sin acción, no
 * pinta nada: la pantalla no se llena de «todo bien».
 */
export async function ParaHoy() {
  const t = FICHA.paraHoy;
  const { due, owners, dates } = await withWorkspace(async (tx) => ({
    due: await listDueToday(tx, LIMITE),
    owners: await listOwnerOptions(tx),
    dates: await getLocalDates(tx),
  }));
  if (due.rows.length === 0 && due.withoutActionCount === 0) return null;

  const f = formatterFor(await getCurrentWorkspace());
  const ctx: SeguimientoContexto = { owners: opcionesDeResponsable(owners, due.rows), ...dates };

  return (
    <section aria-labelledby="para-hoy" className="mb-8">
      <SectionTitle meta={due.rows.length > 0 ? <span className="tabular-nums">{t.meta(due.overdueCount, due.todayCount)}</span> : undefined}>
        <span id="para-hoy">{t.title}</span>
      </SectionTitle>

      {due.rows.length > 0 && (
        <ul aria-label={t.listLabel} className="divide-y divide-border rounded-md border border-border">
          {due.rows.map((r) => {
            const negocio = dealLabel(r.companyName, r.dealName);
            return (
              <li key={r.dealId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
                <div className="min-w-0">
                  <Link href={`/ventas/empresas/${r.companyId}`} className="text-sm font-medium text-ink hover:underline">
                    {r.companyName}
                  </Link>
                  <p className="mt-0.5 truncate text-xs text-muted">{[negocio, r.stageLabel].filter(Boolean).join(" · ")}</p>
                </div>
                <SiguienteAccion
                  data={siguienteAccionData(r, f, dates, negocio ? `${r.companyName} · ${negocio}` : r.companyName)}
                  ctx={ctx}
                />
              </li>
            );
          })}
        </ul>
      )}

      {(due.moreCount > 0 || due.withoutActionCount > 0) && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
          {due.moreCount > 0 && (
            <Link href="/ventas?vista=pipeline&forma=lista" className="underline underline-offset-4 hover:text-ink">
              {t.more(due.moreCount)}
            </Link>
          )}
          {due.withoutActionCount > 0 && (
            <span>
              <span className="text-warn">{t.withoutAction(due.withoutActionCount)}</span>{" "}
              <Link href="/ventas?vista=pipeline&forma=lista" className="underline underline-offset-4 hover:text-ink">
                {t.fixWithoutAction}
              </Link>
            </span>
          )}
        </p>
      )}
    </section>
  );
}
