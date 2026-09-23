import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "@mc/core";
import type { InvoiceListRow } from "@mc/db/queries/finanzas";
import type { ChainLinks } from "@mc/db/queries/ventas-ficha";
import { Pill, type PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { pillForCampaign } from "../../../campanas/_lib/estado";
import { estadoVisible, pillDeCotizacion } from "../../../cotizar/_lib/estado";
import { pillForInvoice } from "../../../finanzas/_lib/estado";
import { FICHA } from "../messages";

/**
 * Lo que salió de un negocio, hacia adelante (VEN-5): sus cotizaciones →
 * la campaña → la factura, cada una con su estado y enlazada a su módulo.
 * Solo lo que existe: un negocio abierto sin nada dice «Sin cotización
 * todavía»; uno ganado o perdido sin nada, «Sin cotización», porque ya no
 * va a llegar.
 *
 * Los estados y sus colores son los de cada módulo (Cotizar, Campañas,
 * Finanzas), importados tal cual: la cadena no tiene su propia versión de
 * qué es una factura vencida. Las versiones de una cotización que dejó
 * sin efecto otra más reciente (0033) no se repiten aquí.
 */
export function Cadena({
  links,
  invoices,
  f,
  label,
  closed = false,
}: {
  links: ChainLinks | undefined;
  /** Las facturas de la empresa como las lee Finanzas, por id: de ahí salen su estado y su mora. */
  invoices: ReadonlyMap<string, InvoiceListRow>;
  f: Formatter;
  label: string;
  /** El negocio ya se ganó o se perdió. */
  closed?: boolean;
}) {
  const t = FICHA.cadena;
  const quotes = (links?.quotes ?? []).filter((q) => !q.supersededById);
  const campaigns = links?.campaigns ?? [];
  const facturas = (links?.invoices ?? []).flatMap((i) => {
    const row = invoices.get(i.id);
    return row ? [row] : [];
  });

  if (quotes.length === 0 && campaigns.length === 0 && facturas.length === 0) {
    return <p className="text-xs text-muted">{closed ? t.noQuoteClosed : t.noQuote}</p>;
  }

  type Paso = { key: string; href: string; title: string; text: string; extra: string | null; pill: { kind: PillKind; text: string } | null };
  const grupos: { key: string; label: string; pasos: Paso[] }[] = [
    {
      key: "quotes",
      label: t.quote,
      pasos: quotes.map((q) => ({
        key: q.id,
        href: `/cotizar/cotizaciones/${q.id}`,
        title: `${t.quote} ${q.number}`,
        text: q.number,
        extra: f.money(q.total, q.currency, { mode: "short" }),
        pill: pillDeCotizacion(estadoVisible(q)),
      })),
    },
    {
      key: "campaigns",
      label: t.campaign,
      pasos: campaigns.map((c) => ({
        key: c.id,
        href: `/campanas/${c.id}`,
        title: `${t.campaign} ${c.name}`,
        text: c.name,
        extra: null,
        pill: (CAMPAIGN_STATUSES as readonly string[]).includes(c.status) ? pillForCampaign(c.status as CampaignStatus) : null,
      })),
    },
    {
      key: "invoices",
      label: t.invoice,
      pasos: facturas.map((i) => ({
        key: i.id,
        href: `/finanzas/facturas/${i.id}`,
        title: `${t.invoice} ${i.number}`,
        text: i.number,
        extra: f.money(i.total, i.currency, { mode: "short" }),
        pill: pillForInvoice(i),
      })),
    },
  ].filter((g) => g.pasos.length > 0);

  // Una flecha entre eslabones (cotización → campaña → factura), no entre
  // dos cotizaciones del mismo negocio.
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      {grupos.map((g, i) => (
        <li key={g.key} className="relative flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />}
          <span className="sr-only">{g.label}:</span>
          {g.pasos.map((p) => (
            <span key={p.key} className="flex min-w-0 items-center gap-1.5">
              <Link href={p.href} aria-label={p.title} className="min-w-0 truncate font-medium text-ink underline-offset-4 hover:underline">
                {p.text}
              </Link>
              {p.extra && <span className="whitespace-nowrap tabular-nums text-muted">{p.extra}</span>}
              {p.pill && <Pill kind={p.pill.kind}>{p.pill.text}</Pill>}
            </span>
          ))}
        </li>
      ))}
    </ol>
  );
}
