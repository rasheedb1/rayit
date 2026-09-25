import { Pill } from "@/components/ui/pill";
import { PITCH } from "./messages";
import type { Revision } from "./vista";

/**
 * La columna de la derecha del editor: cómo lo recibe la marca (sin
 * marcas, con las variables rellenas), qué cifras cita y de dónde salen,
 * y la revisión antes de enviar, en línea mientras se escribe. Si el
 * borrador lo redactó la IA, su nota de calidad va arriba.
 */
export function VistaYRevision({
  preview,
  recipient,
  revision,
  quality,
}: {
  preview: { subject: string; body: string };
  recipient: string | null;
  revision: Revision;
  quality: { score: string | null; note: string | null; held: string | null } | null;
}) {
  const v = PITCH.vista;
  const r = PITCH.revision;
  return (
    <div className="grid gap-6">
      {quality && (quality.score || quality.note || quality.held) && (
        <section aria-labelledby="pitch-calidad" className="rounded-md border border-border bg-surface-2 p-3">
          <h2 id="pitch-calidad" className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {r.calidad}
            {quality.score && <span className="tabular-nums">{r.nota(quality.score)}</span>}
          </h2>
          {quality.note && <p className="mt-1 text-sm text-ink-2">{quality.note}</p>}
          {quality.held && <p className="mt-1 text-xs text-muted">{quality.held}</p>}
        </section>
      )}

      <section aria-labelledby="pitch-vista">
        <h2 id="pitch-vista" className="text-sm font-medium text-ink">
          {v.titulo}
        </h2>
        <p className="mb-2 text-xs text-muted">{recipient ? v.para(recipient) : v.sinDestinatario}</p>
        <div className="rounded-md border border-border bg-surface p-3 text-sm">
          <p className="mb-2 break-words font-medium text-ink">{preview.subject || <span className="text-muted">{v.sinAsunto}</span>}</p>
          {preview.body ? (
            <p className="whitespace-pre-wrap break-words leading-6 text-ink-2">{preview.body}</p>
          ) : (
            <p className="text-muted">{v.vacio}</p>
          )}
        </div>
        <h3 className="mb-1 mt-3 text-xs font-medium text-ink">{v.citadas}</h3>
        {revision.cited.length === 0 ? (
          <p className="text-xs text-muted">{v.ninguna}</p>
        ) : (
          <ul className="grid gap-1 text-xs">
            {revision.cited.map((c) => (
              <li key={c.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-medium tabular-nums text-ink">{c.display}</span>
                <span className="min-w-0 break-words text-ink-2">{c.label}</span>
                <span className="text-muted">· {PITCH.origen[c.source]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pitch-revision">
        <h2 id="pitch-revision" className="mb-2 text-sm font-medium text-ink">
          {r.titulo}
        </h2>
        {revision.ok ? (
          <p className="flex items-start gap-2 text-sm text-ink-2">
            <Pill kind="good">{r.listo}</Pill>
            <span>{r.ok}</span>
          </p>
        ) : revision.pristine && revision.items.length === 0 ? (
          // Recién abierto y vacío: todavía no hay nada mal, solo nada escrito.
          <p className="text-sm text-muted">{r.vacioNeutro}</p>
        ) : (
          <>
            <p className="mb-1 text-xs text-muted">{r.bloquea}</p>
            <ul className="grid gap-1.5 text-sm">
              {revision.items.map((i, n) => (
                <li key={`${i.code}-${n}`} className="flex items-start gap-2 text-ink-2">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
                  <span className="min-w-0 break-words">{i.text}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
