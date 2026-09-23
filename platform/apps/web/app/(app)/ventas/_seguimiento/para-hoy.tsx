import { listOwnerOptions } from "@mc/db/queries/ventas";
import { getLocalDates, listDueToday } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { FICHA, type Conteo } from "../empresas/messages";
import { withWorkspace } from "../_lib/db";
import { contextoDeSeguimiento, siguienteAccionData } from "./datos";
import { ParaHoyLista, type FilaParaHoy } from "./para-hoy-lista";

/** Cuántos seguimientos enseña el bloque; el resto se ve en el pipeline. */
const LIMITE = 6;

/** Los enlaces del bloque: el pipeline en lista, filtrado a lo que el enlace promete y con el foco de la página en él (#pipeline). */
export const PARA_HOY_HREF = {
  more: "/ventas?vista=pipeline&forma=lista&seguimiento=para_hoy#pipeline",
  withoutAction: "/ventas?vista=pipeline&forma=lista&seguimiento=sin_accion#pipeline",
} as const;

/**
 * «Para hoy», arriba de /ventas (VEN-4): los negocios abiertos cuya
 * siguiente acción ya venció o vence hoy en la zona del espacio, primero
 * lo más vencido, cada uno con su línea editable («Hecha», «Cambiar»).
 * Debajo, cuántos negocios abiertos no tienen siguiente acción, con el
 * enlace al pipeline filtrado a esos negocios.
 *
 * Se monta con una línea (`<ParaHoy />`): lee lo suyo en su propia
 * transacción y le pasa a la lista (de cliente) las filas y los textos ya
 * formateados con el locale del espacio. La lista es la que no suelta la
 * fila que se está tocando cuando la revalidación la saca de aquí.
 */
export async function ParaHoy() {
  const t = FICHA.paraHoy;
  const { due, owners, dates } = await withWorkspace(async (tx) => ({
    due: await listDueToday(tx, LIMITE),
    owners: await listOwnerOptions(tx),
    dates: await getLocalDates(tx),
  }));

  const f = formatterFor(await getCurrentWorkspace());
  const conteo: Conteo = { int: f.int, plural: new Intl.PluralRules(f.locale) };
  const ctx = contextoDeSeguimiento(owners, due.rows, dates, f);

  const filas: FilaParaHoy[] = due.rows.map((r) => {
    const negocio = dealLabel(r.companyName, r.dealName);
    return {
      dealId: r.dealId,
      companyId: r.companyId,
      companyName: r.companyName,
      dealName: negocio,
      stageLabel: r.stageLabel,
      data: siguienteAccionData(r, f, ctx, negocio ? `${r.companyName} · ${negocio}` : r.companyName),
    };
  });

  // Aunque no haya nada, la lista se monta: si la persona acaba de
  // guardar el último seguimiento del día, es ella la que dice dónde
  // quedó. Sin nada que decir, no pinta nada.
  return (
    <ParaHoyLista
      filas={filas}
      ctx={ctx}
      meta={due.rows.length > 0 ? t.meta(due.overdueCount, due.todayCount, conteo) : null}
      more={due.moreCount > 0 ? { text: t.more(due.moreCount, conteo), href: PARA_HOY_HREF.more } : null}
      withoutAction={
        due.withoutActionCount > 0 ? { text: t.withoutAction(due.withoutActionCount, conteo), href: PARA_HOY_HREF.withoutAction } : null
      }
    />
  );
}
