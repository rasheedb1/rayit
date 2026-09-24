import type { CadenceTouch } from "@mc/db/queries/outreach";
import { holdReasonText, noticeLang } from "@mc/core/outreach/messages";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { FICHA } from "../messages";
import { AprobarMensaje } from "./aprobar";
import { Bloque } from "./bloque";

/** Lo primero de una respuesta, en una línea: la conversación entera es de VEN-16. */
function recortar(texto: string, max = 240): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  const letras = [...limpio];
  return letras.length > max ? `${letras.slice(0, max).join("")}…` : limpio;
}

/** El color de cada estado: lo que espera a la persona avisa; lo que salió, bien; lo que no salió, mal. */
const KIND: Record<string, PillKind> = {
  held: "warn",
  draft: "neutral",
  scheduled: "neutral",
  processing: "neutral",
  sent: "good",
  failed: "bad",
  skipped: "neutral",
  canceled: "neutral",
};

/**
 * «Mensajes de la cadencia» (VEN-10 r5): los mensajes de las secuencias
 * para esta empresa, con los retenidos arriba, su motivo en palabras y
 * «Revisar y aprobar». Es adonde llevan los avisos del motor («Un mensaje
 * a X espera tu revisión»); la bandeja completa de todas las empresas es
 * VEN-16. Server Component: el formulario de aprobar es el único cliente.
 */
export function MensajesDeCadencia({ companyId, touches, f }: { companyId: string; touches: CadenceTouch[]; f: Formatter }) {
  const t = FICHA.cadencia;
  const lang = noticeLang(f.locale);
  const pendientes = touches.filter((x) => x.status === "held").length;
  const persona = (x: CadenceTouch) => x.contactName ?? t.sinNombre;

  const columns: Column<CadenceTouch>[] = [
    {
      key: "persona",
      header: t.columnas.persona,
      render: (x) => (
        <CellMain
          sub={x.sequenceName && x.stepIndex !== null ? t.paso(x.sequenceName, f.int(x.stepIndex)) : t.pasoSuelto}
        >
          {persona(x)}
        </CellMain>
      ),
    },
    { key: "canal", header: t.columnas.canal, render: (x) => t.canales[x.channel] ?? x.channel },
    {
      key: "estado",
      header: t.columnas.estado,
      render: (x) => (
        <div className="grid min-w-0 gap-2">
          <span>
            <Pill kind={KIND[x.status] ?? "neutral"}>{t.estados[x.status] ?? x.status}</Pill>
          </span>
          {x.reply && (
            <p className="text-xs text-ink-2">
              {t.respondio(f.dateTime(x.reply.occurredAt.toISOString()))}{" "}
              <q className="text-ink">{recortar(x.reply.body)}</q>
            </p>
          )}
          {x.status === "held" && (
            <>
              {x.heldReason && <p className="text-xs text-ink-2">{t.porQue(holdReasonText(lang, x.heldReason))}</p>}
              <AprobarMensaje
                companyId={companyId}
                touchId={x.id}
                persona={persona(x)}
                isEmail={x.channel === "email"}
                subject={x.subject}
                body={x.body}
              />
            </>
          )}
        </div>
      ),
    },
    {
      key: "cuando",
      header: t.columnas.cuando,
      render: (x) => (
        <span className="whitespace-nowrap tabular-nums text-ink-2">
          {x.sentAt ? t.salio(f.dateTime(x.sentAt.toISOString())) : x.scheduledFor ? t.sale(f.dateTime(x.scheduledFor.toISOString())) : ""}
        </span>
      ),
    },
  ];

  return (
    <Bloque id="cadencia" title={t.title} meta={pendientes > 0 ? t.meta(f.int(pendientes)) : undefined}>
      <DataTable
        columns={columns}
        rows={touches}
        rowKey={(x) => x.id}
        caption={t.caption}
        density="compact"
        emptyState={<EmptyState title={t.vacio.title} description={t.vacio.description} />}
      />
    </Bloque>
  );
}
