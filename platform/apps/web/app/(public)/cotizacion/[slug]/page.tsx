import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { readPublicQuote } from "@mc/db/queries/cotizar";
import { withPublicShare } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";
import { DocumentoCotizacion } from "@/app/(app)/cotizar/_ui/documento-cotizacion";
import { AceptarCotizacion, CotizacionYaAceptada } from "./aceptar";

// Cada visita se registra y el estado cambia: nada de caché.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * UNA lectura por petición, compartida entre generateMetadata y la
 * página (React cache, por petición). public_quote() registra la visita:
 * si el título la leyera por su cuenta, cada apertura contaría dos.
 */
const leerCotizacion = cache(async (slug: string) => {
  const robot = esRobotDePrevisualizacion((await headers()).get("user-agent"));
  return withPublicShare((tx) => readPublicQuote(tx, slug, { count: !robot }));
});

/**
 * La pestaña de la marca dice qué documento es y de quién:
 * «COT-2026-005 · Laura Ríos», como el asunto de una factura. Nunca se
 * indexa, aunque el enlace acabe pegado en una web.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await leerCotizacion(slug);
  const m = MESSAGES.meta;
  return {
    title: r.status === "ok" ? m.cotizacionPublica(r.quote.number, r.quote.creator.displayName) : m.cotizacionPublicaSinDatos,
    robots: { index: false, follow: false },
  };
}

/**
 * La cotización que abre la marca (COT-3 y COT-4), sin sesión.
 *
 * Lo que se ve es el snapshot congelado al enviarla —lo que se envió,
 * no lo que el creador haya editado después— más el estado de hoy, que
 * es lo único vivo. Lo entrega `public_quote(slug)` (migración 0030), que
 * además la marca como vista… salvo si quien pide es el robot de
 * WhatsApp o Slack pintando la vista previa del enlace: eso no es la
 * marca. Un enlace que no existe es un 404 (not-found.tsx).
 */
export default async function CotizacionPublicaPage({ params }: Props) {
  const { slug } = await params;
  const t = MESSAGES.publico.cotizacion;
  const resultado = await leerCotizacion(slug);
  if (resultado.status !== "ok") notFound();

  const q = resultado.quote;
  const f = formatterFor({ locale: q.locale, currency: q.currency, timezone: q.timezone });
  const accion =
    q.status === "sent" || q.status === "viewed" ? (
      <AceptarCotizacion slug={q.slug} />
    ) : q.status === "accepted" ? (
      // El estado leído al abrir, no la respuesta a una firma: quien
      // recarga puede ser otra persona de la marca (pulido r7).
      <CotizacionYaAceptada nombre={q.acceptedByName ?? null} fecha={q.acceptedAt ? f.date(q.acceptedAt, "long") : null} />
    ) : (
      <p className="text-sm text-ink-2">{q.status === "rejected" ? t.rechazada : q.superseded ? t.sinEfecto : t.vencida}</p>
    );

  return <DocumentoCotizacion q={q} accion={accion} enlaceKit={q.mediaKitSlug ? `/kit/${q.mediaKitSlug}` : null} />;
}
