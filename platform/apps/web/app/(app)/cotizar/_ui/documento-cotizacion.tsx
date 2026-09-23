import type { ReactNode } from "react";
import Link from "next/link";
import type { PublicQuoteView } from "@mc/db/queries/cotizar";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { etiquetaImpuesto, lineasAcordado } from "../_lib/acordado";
import { ResumenTotales } from "./resumen-totales";

/**
 * La cotización como documento: lo que ve la marca en
 * /cotizacion/<slug> y lo que ve el creador en la vista previa del
 * panel. Es EL MISMO componente en los dos sitios, así que la vista
 * previa no puede mentir sobre lo que la marca tiene delante.
 *
 * Solo props: no consulta nada ni registra visitas. `accion` es lo de
 * abajo (el botón de aceptar, el aviso de la vista previa) y
 * `enlaceKit` decide adónde lleva el media kit que la acompaña.
 *
 * Limpieza de referencia: la página alojada de una factura de Stripe.
 */
export function DocumentoCotizacion({
  q,
  accion,
  enlaceKit,
}: {
  q: PublicQuoteView;
  accion?: ReactNode;
  enlaceKit?: string | null;
}) {
  const t = MESSAGES.publico.cotizacion;
  const f = formatterFor({ locale: q.locale, currency: q.currency, timezone: q.timezone });
  const dinero = (v: string) => f.money(v, q.currency, { mode: "full" });

  return (
    <article className="space-y-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-wide text-muted">
          {t.title} · {q.number}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{q.company.name}</h1>
        <p className="mt-2 text-sm text-ink-2">
          {t.de} {q.creator.displayName}
          {q.creator.handle ? ` · ${q.creator.handle}` : ""}
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
          {q.status === "accepted" && q.acceptedAt ? (
            <Pill kind="good">
              {q.acceptedByName ? t.aceptadaPor(q.acceptedByName, f.date(q.acceptedAt, "long")) : t.aceptada(f.date(q.acceptedAt, "long"))}
            </Pill>
          ) : q.validUntil ? (
            <span>{t.valida(f.date(q.validUntil, "long"))}</span>
          ) : null}
        </p>
      </header>

      <section aria-labelledby="doc-entregables">
        <h2 id="doc-entregables" className="text-sm font-semibold">
          {t.entregables}
        </h2>
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {q.items.map((i, idx) => (
            <li key={`${i.description}-${idx}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm">{i.description}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {i.platformId && <PlatformPill platformId={i.platformId} />}
                  <span className="tabular-nums">
                    {t.cantidad} {f.int(i.quantity)} · {dinero(i.unitPrice)}
                  </span>
                </span>
              </span>
              <span className="font-mono text-sm tabular-nums">{dinero(i.total)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t.total}>
        <ResumenTotales totales={q} currency={q.currency} f={f} etiquetaImpuesto={etiquetaImpuesto(q.taxRate, f)} />
      </section>

      <section aria-labelledby="doc-acordado">
        <h2 id="doc-acordado" className="text-sm font-semibold">
          {t.acordado}
        </h2>
        <dl className="mt-3 divide-y divide-border rounded-md border border-border">
          {lineasAcordado(q.acordado, f).map((linea) => (
            <div key={linea.termino} className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-sm">
              <dt className="text-ink-2">{linea.termino}</dt>
              <dd className="text-right">{linea.valor}</dd>
            </div>
          ))}
        </dl>
      </section>

      {accion && <section aria-label={t.aceptar}>{accion}</section>}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted">
        <span>{t.pie}</span>
        {enlaceKit && (
          <Link href={enlaceKit} className="underline-offset-2 hover:underline">
            {MESSAGES.publico.kit.title}
          </Link>
        )}
      </footer>
    </article>
  );
}
