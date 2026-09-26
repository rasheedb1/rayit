import Link from "next/link";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Aviso } from "../../_lib/aviso";
import { MESSAGES } from "./messages";
import { CrearReferido, MarcarLeido, Responder } from "./responder";
import type { ConversacionVista, MensajeVista } from "./vista";

const t = MESSAGES;

/**
 * La conversación completa con una ficha por un canal: arriba quién es,
 * el negocio y la siguiente acción, con el enlace a la ficha (Front:
 * las acciones arriba); en medio los mensajes en orden, los suyos a la
 * izquierda y los tuyos a la derecha, con la intención de cada respuesta;
 * abajo, lo que está por salir y la respuesta.
 */
export function Conversacion({ c }: { c: ConversacionVista }) {
  return (
    <section aria-labelledby="conversacion-titulo" className="grid gap-4">
      <MarcarLeido contactId={c.contactId} channel={c.channel} sinLeer={c.sinLeer} />
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <Link href="/ventas/bandeja" className="mb-2 inline-block text-xs text-ink-2 hover:text-ink lg:hidden">
            ← {t.conversacion.volver}
          </Link>
          <h2 id="conversacion-titulo" className="text-lg font-medium text-ink">
            {c.persona}
          </h2>
          <p className="text-sm text-ink-2">
            {c.empresa} · {c.canal}
          </p>
          {c.negocio || c.siguiente ? (
            <p className="mt-1 text-xs text-ink-2">{[c.negocio, c.siguiente].filter(Boolean).join(" · ")}</p>
          ) : null}
        </div>
        <Button size="sm" variant="secondary" href={c.fichaHref}>
          {t.conversacion.verFicha}
        </Button>
      </header>

      <ol className="grid gap-3" role="list">
        {c.mensajes.map((m) => (
          <li key={m.id} className={`flex ${m.deNosotros ? "justify-end" : "justify-start"}`}>
            <Mensaje m={m} />
          </li>
        ))}
      </ol>

      {c.pendientes.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-xs font-medium text-ink-2">{t.responder.pendientesTitulo(c.pendientes.length)}</p>
          {c.pendientes.map((p) => (
            <div key={p.touchId} className="ml-auto w-full max-w-xl rounded-md border border-dashed border-border bg-surface p-3 text-sm">
              <div className="mb-1">
                <Pill kind="neutral">{p.estado}</Pill>
              </div>
              <p className="whitespace-pre-wrap break-words text-ink-2">{p.cuerpo}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="border-t border-border pt-4">
        {c.bloqueo ? (
          <div className="grid gap-2">
            <Aviso info={t.responder.bloqueos[c.bloqueo]} />
            {c.bloqueo === "no_account" ? (
              <div>
                <Button size="sm" variant="secondary" href={OUTREACH_URLS.channels}>
                  {t.responder.irACanales}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            {c.envioApagado ? (
              <div className="flex flex-wrap items-center gap-3">
                <Aviso info={t.responder.envioApagado} className="flex-1" />
                <Button size="sm" variant="secondary" href={OUTREACH_URLS.policySwitch}>
                  {t.responder.irAPolitica}
                </Button>
              </div>
            ) : null}
            <Responder
              contactId={c.contactId}
              channel={c.channel}
              ayuda={c.cuenta ? t.responder.ayuda(c.cuenta) : t.responder.ayudaSinCuenta}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function Mensaje({ m }: { m: MensajeVista }) {
  const intencion = m.intencion ? t.intenciones[m.intencion] : null;
  return (
    <article
      className={`w-full max-w-xl rounded-md border p-3 text-sm ${
        m.deNosotros ? "border-border bg-surface-2" : "border-border bg-surface"
      }`}
    >
      <p className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
        <span>{m.deNosotros ? t.conversacion.tu : null}</span>
        <time className="tabular-nums">{m.cuando}</time>
      </p>
      {m.asunto ? (
        <p className="mb-1 font-medium text-ink">
          <span className="sr-only">{t.conversacion.asunto}: </span>
          {m.asunto}
        </p>
      ) : null}
      <p className="whitespace-pre-wrap break-words leading-6 text-ink">{m.cuerpo}</p>
      {intencion ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pill kind={intencion.kind}>{intencion.label}</Pill>
            {m.clasificacion ? <span className="text-xs text-ink-2">{m.clasificacion}</span> : null}
          </div>
          {m.vuelve ? <p className="text-xs text-ink-2">{m.vuelve}</p> : null}
          {m.referido ? (
            <div className="grid gap-2">
              <p className="text-xs text-ink">{m.referido.propuesta}</p>
              {m.referido.creado ? (
                <p className="text-xs text-good">{t.referido.creado}</p>
              ) : (
                <CrearReferido messageId={m.id} nombre={m.referido.nombre} correo={m.referido.correo} cargo={m.referido.cargo} />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
