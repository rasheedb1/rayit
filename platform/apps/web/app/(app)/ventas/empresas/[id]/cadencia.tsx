import type { CadenceTouch } from "@mc/db/queries/outreach";
import { holdReasonText, noticeLang, parseHoldReason } from "@mc/core/outreach/messages";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { FICHA } from "../messages";
import { AprobarMensaje } from "./aprobar";
import { ResolverIntento } from "./intento";
import { ReanudarCadencia } from "./reanudar";
import { SaltarMensaje } from "./saltar";
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
 * «Mensajes de la cadencia» (VEN-10): los mensajes de las secuencias
 * para esta empresa, con los retenidos arriba (después, cada secuencia en
 * el orden en que salen sus mensajes), su motivo en palabras y
 * «Revisar y aprobar» con «Saltar este paso» (o, si no se supo si un
 * intento salió, «Sí, salió» / «No salió: enviarlo»), y «Reanudar la
 * cadencia» en la primera fila de una cadencia en pausa. Es adonde llevan los avisos del motor («Un mensaje
 * a X espera tu revisión»); la bandeja completa de todas las empresas es
 * VEN-16. Server Component: el formulario de aprobar es el único cliente.
 */
export function MensajesDeCadencia({ companyId, touches, f }: { companyId: string; touches: CadenceTouch[]; f: Formatter }) {
  const t = FICHA.cadencia;
  const lang = noticeLang(f.locale);
  const pendientes = touches.filter((x) => x.status === "held").length;
  const persona = (x: CadenceTouch) => x.contactName ?? t.sinNombre;
  // «Reanudar» una vez por cadencia en pausa (0054): en la primera fila de su enrolamiento.
  const vistos = new Set<string>();
  const reanudarEn = new Set<string>();
  for (const x of touches) {
    if (x.enrollmentStatus !== "paused" || !x.enrollmentId || vistos.has(x.enrollmentId)) continue;
    vistos.add(x.enrollmentId);
    reanudarEn.add(x.id);
  }

  const canal = (x: CadenceTouch) => t.canales[x.channel] ?? x.channel;
  const cuando = (x: CadenceTouch) =>
    x.sentAt ? t.salio(f.dateTime(x.sentAt.toISOString())) : x.scheduledFor ? t.sale(f.dateTime(x.scheduledFor.toISOString())) : "";

  // Dos columnas, para que a 400 px se lea sin mover la tabla: quién, por
  // dónde y cuándo en la primera (lo primero que busca la creadora), y el
  // estado con lo que hay que hacer en la segunda.
  const columns: Column<CadenceTouch>[] = [
    {
      key: "persona",
      header: t.columnas.persona,
      render: (x) => (
        <CellMain
          sub={
            <>
              <span className="block tabular-nums">{t.linea(canal(x), cuando(x))}</span>
              <span className="block">
                {x.sequenceName && x.stepIndex !== null ? t.paso(x.sequenceName, f.int(x.stepIndex)) : t.pasoSuelto}
              </span>
            </>
          }
        >
          {persona(x)}
        </CellMain>
      ),
    },
    {
      key: "estado",
      header: t.columnas.estado,
      render: (x) => {
        const sinConfirmar = x.status === "held" && parseHoldReason(x.heldReason)?.code === "unconfirmed_attempt";
        return (
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
            {x.status === "held" && !sinConfirmar && (
              <>
                {x.heldReason && <p className="text-xs text-ink-2">{t.porQue(holdReasonText(lang, x.heldReason))}</p>}
                <AprobarMensaje
                  companyId={companyId}
                  touchId={x.id}
                  persona={persona(x)}
                  isEmail={x.channel === "email"}
                  isReply={x.stepType === "email_reply"}
                  threadSubject={x.threadSubject}
                  subject={x.subject}
                  body={x.body}
                />
                <SaltarMensaje companyId={companyId} touchId={x.id} />
              </>
            )}
            {reanudarEn.has(x.id) && x.enrollmentId && (
              <ReanudarCadencia companyId={companyId} enrollmentId={x.enrollmentId} persona={persona(x)} />
            )}
            {sinConfirmar && (
              <ResolverIntento
                companyId={companyId}
                touchId={x.id}
                persona={persona(x)}
                canal={t.canalesEnFrase[x.channel] ?? x.channel}
                subject={x.channel === "email" ? x.subject : null}
                body={x.body}
                cuenta={x.accountName}
                dia={x.unconfirmedDay ? f.date(x.unconfirmedDay, "long") : null}
              />
            )}
          </div>
        );
      },
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
