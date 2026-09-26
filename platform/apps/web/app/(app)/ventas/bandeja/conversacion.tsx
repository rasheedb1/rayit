import Link from "next/link";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Aviso } from "../../_lib/aviso";
import { CorregirIntencion, MarcarHecha } from "./acciones";
import { MESSAGES, type Intencion } from "./messages";
import { CrearReferido, MarcarLeido, Respuestas } from "./responder";
import type { ConversacionVista, MensajeVista } from "./vista";

const t = MESSAGES;
type Canal = "email" | "linkedin" | "instagram_dm";

/**
 * La conversación completa con una ficha por un canal: arriba quién es,
 * el negocio y la siguiente acción, con «Marcar como hecha» y el enlace a
 * la ficha (Front: las acciones arriba); en medio los mensajes en orden,
 * los suyos a la izquierda y los tuyos a la derecha, con la intención de
 * cada respuesta, su porqué y «Corregir»; abajo, lo que está por salir, lo
 * que no salió y la respuesta.
 */
export function Conversacion({ c, volverHref }: { c: ConversacionVista; volverHref: string }) {
  const canal = c.channel as Canal;
  return (
    <section aria-labelledby="conversacion-titulo" className="grid gap-4">
      <MarcarLeido contactId={c.contactId} channel={canal} sinLeer={c.sinLeer} implicita={c.implicita} />
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <Link href={volverHref} className="mb-2 inline-block text-xs text-ink-2 hover:text-ink lg:hidden">
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
        <div className="flex flex-wrap items-start gap-2">
          <MarcarHecha contactId={c.contactId} channel={canal} hecha={c.hecha} />
          <Button size="sm" variant="secondary" href={c.fichaHref}>
            {t.conversacion.verFicha}
          </Button>
        </div>
      </header>

      {c.clasificadorApagado ? <Aviso warning={t.conversacion.clasificadorApagado} /> : null}

      <ol className="grid gap-3" role="list">
        {c.mensajes.map((m) => (
          <li key={m.id} className={`flex ${m.deNosotros ? "justify-end" : "justify-start"}`}>
            <Mensaje m={m} opciones={c.opcionesIntencion} enrolarHref={c.enrolarHref} />
          </li>
        ))}
      </ol>

      <div className="border-t border-border pt-4">
        {c.bloqueo ? (
          <div className="mb-3 grid gap-2">
            <Aviso info={t.responder.bloqueos[c.bloqueo]} />
            {c.bloqueo === "no_account" ? (
              <div>
                <Button size="sm" variant="secondary" href={OUTREACH_URLS.channels}>
                  {t.responder.irACanales}
                </Button>
              </div>
            ) : null}
          </div>
        ) : c.envioApagado ? (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Aviso info={t.responder.envioApagado} className="flex-1" />
            <Button size="sm" variant="secondary" href={OUTREACH_URLS.policySwitch}>
              {t.responder.irAPolitica}
            </Button>
          </div>
        ) : null}
        <Respuestas
          contactId={c.contactId}
          channel={canal}
          ayuda={c.cuenta ? t.responder.ayuda(c.cuenta) : t.responder.ayudaSinCuenta}
          porSalir={c.porSalir}
          noSalieron={c.noSalieron}
          puedeResponder={c.bloqueo === null}
        />
      </div>
    </section>
  );
}

function Mensaje({
  m, opciones, enrolarHref,
}: { m: MensajeVista; opciones: Array<{ value: Intencion; label: string }>; enrolarHref: string }) {
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
          {m.porque ? <p className="text-xs text-ink-2">{m.porque}</p> : null}
          {m.vuelve ? <p className="text-xs text-ink-2">{m.vuelve}</p> : null}
          {m.enfria ? <p className="text-xs text-ink-2">{m.enfria}</p> : null}
          {m.referido ? (
            <div className="grid gap-2">
              <p className="text-xs text-ink">{m.referido.propuesta}</p>
              {m.referido.creado ? (
                <p className="text-xs text-good">{t.referido.creado}</p>
              ) : (
                <CrearReferido
                  messageId={m.id}
                  nombre={m.referido.nombre}
                  correo={m.referido.correo}
                  cargo={m.referido.cargo}
                  enrolarHref={enrolarHref}
                />
              )}
            </div>
          ) : null}
          {m.corregible ? (
            <div>
              <CorregirIntencion
                messageId={m.id}
                actual={m.intencion === "pendiente" || m.intencion === null ? null : m.intencion}
                opciones={opciones}
              />
            </div>
          ) : (
            <p className="text-xs text-ink-2">{t.corregir.bajaNoSeCorrige}</p>
          )}
        </div>
      ) : null}
    </article>
  );
}
