"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { BandejaChannel } from "@mc/db/queries/bandejas";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { Aviso } from "../../_lib/aviso";
import { cancelarRespuesta, crearReferido, descartarRespuesta, marcarLeido, responder, type ResultadoBandeja } from "./actions";
import { MESSAGES } from "./messages";
import type { PendienteVista } from "./vista";

const t = MESSAGES;
/** Donde también espera una respuesta que el envío retuvo. */
const APROBACIONES_HREF = "/ventas/aprobaciones";

/** El id del campo de la respuesta: la tecla r lo enfoca. */
export const RESPUESTA_ID = "bandeja-respuesta";
/** Desde dónde se ven la lista y la conversación a la vez (lg de Tailwind). */
export const ESCRITORIO = "(min-width: 64rem)";

/** Lleva el foco a «Tu respuesta» (la tecla r, un error del campo, «Editar»). */
export function enfocarRespuesta(): boolean {
  const el = document.getElementById(RESPUESTA_ID);
  el?.focus();
  return el !== null;
}

/** ¿Hay algo escrito en «Tu respuesta» que no salió? Los atajos que dejan el hilo lo miran antes. */
export function hayRespuestaSinEnviar(): boolean {
  const el = document.getElementById(RESPUESTA_ID);
  return el instanceof HTMLTextAreaElement && el.value.trim().length > 0;
}

/** El evento con el que los atajos piden a «Tu respuesta» que avise de su borrador (lleva la tecla). */
const BORRADOR_EVENTO = "on-cue:bandeja-borrador";

export function avisarBorrador(tecla: string): void {
  window.dispatchEvent(new CustomEvent(BORRADOR_EVENTO, { detail: tecla }));
}

/**
 * El borrador de cada hilo, en sessionStorage con la ficha y el canal (el
 * de Superhuman: vuelve al volver al hilo). Es una comodidad de este
 * navegador: puede no estar (una ventana privada, datos borrados) y la
 * bandeja funciona igual; por eso todo va en try/catch.
 */
const claveBorrador = (contactId: string, channel: string) => `on-cue:bandeja:borrador:${contactId}:${channel}`;

export function leerBorrador(contactId: string, channel: string): string {
  try {
    return window.sessionStorage.getItem(claveBorrador(contactId, channel)) ?? "";
  } catch {
    return "";
  }
}

export function guardarBorrador(contactId: string, channel: string, texto: string): void {
  try {
    if (texto.trim()) window.sessionStorage.setItem(claveBorrador(contactId, channel), texto);
    else window.sessionStorage.removeItem(claveBorrador(contactId, channel));
  } catch {
    // Sin almacenamiento, el borrador vive mientras la conversación esté abierta.
  }
}

/** Un id nuevo para el próximo envío: el mismo formulario enviado dos veces es UN mensaje. */
function nuevoId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Al abrir un hilo con mensajes sin leer, se marcan leídos (y la lista
 * se refresca para quitarles la negrita). Uno abierto sin pedirlo (el
 * primero sin leer, que la página abre en escritorio) solo se marca si se
 * ve: en un teléfono la conversación está escondida. No pinta nada.
 *
 * La abierta sola, al marcarse, queda fijada en la URL (`fijarHref`, con
 * router.replace) en vez de solo refrescar: si no, el siguiente render ya
 * la ve leída, abre la siguiente sin leer, la marca, y así en cascada
 * hasta dejar la bandeja entera leída sin que nadie la mirara.
 */
export function MarcarLeido({
  contactId, channel, sinLeer, implicita = false, fijarHref = null,
}: { contactId: string; channel: BandejaChannel; sinLeer: number; implicita?: boolean; fijarHref?: string | null }) {
  const router = useRouter();
  useEffect(() => {
    if (sinLeer === 0) return;
    if (implicita && !(typeof window.matchMedia === "function" && window.matchMedia(ESCRITORIO).matches)) return;
    void marcarLeido({ contactId, channel }).then(() =>
      implicita && fijarHref ? router.replace(fijarHref, { scroll: false }) : router.refresh(),
    );
  }, [contactId, channel, sinLeer, implicita, fijarHref, router]);
  return null;
}

/**
 * Las respuestas escritas aquí y la caja para escribir otra. Arriba, las
 * que esperan salir, con «Cancelar» y «Editar» (el «deshacer envío» de
 * Superhuman: mientras el despachador no la tome, no sale); después, las
 * que no salieron con su motivo y «Descartar»; abajo, «Tu respuesta». Sale
 * por el motor (la cuenta y el hilo del mensaje, el pie de baja en un
 * correo), no desde el navegador. Al salir bien, el campo se vacía, el
 * aviso lo dice y el próximo envío lleva otro id; si falla, el id se queda
 * (reintentar no crea otro mensaje). Lo escrito se guarda por hilo
 * (leerBorrador): pasar a otra conversación con j o k, o marcar esta como
 * hecha, no lo pierde.
 */
export function Respuestas({
  contactId, channel, ayuda, porSalir, noSalieron, puedeResponder, puedeOperar = true, maxCaracteres,
}: {
  contactId: string;
  channel: BandejaChannel;
  ayuda: string;
  porSalir: PendienteVista[];
  noSalieron: PendienteVista[];
  puedeResponder: boolean;
  /** Su rol deja operar la bandeja (PUEDEN_OPERAR_VENTAS): sin él, se lee y no se ofrece nada. */
  puedeOperar?: boolean;
  /** El tope de la respuesta (INBOX_REPLY_MAX_CHARS de @mc/db): el mismo que mira el servidor. */
  maxCaracteres: number;
}) {
  const [touchId, setTouchId] = useState(nuevoId);
  const [texto, setTextoEstado] = useState("");
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  const [avisoBorrador, setAvisoBorrador] = useState<string | null>(null);

  // El borrador se lee al montar (no en el servidor: sessionStorage es del navegador).
  useEffect(() => {
    const guardado = leerBorrador(contactId, channel);
    if (guardado) setTextoEstado(guardado);
  }, [contactId, channel]);
  useEffect(() => {
    const onAviso = (e: Event) => setAvisoBorrador(t.responder.borradorPendiente(String((e as CustomEvent<string>).detail)));
    window.addEventListener(BORRADOR_EVENTO, onAviso);
    return () => window.removeEventListener(BORRADOR_EVENTO, onAviso);
  }, []);

  function setTexto(v: string) {
    setTextoEstado(v);
    setAvisoBorrador(null);
    guardarBorrador(contactId, channel, v);
  }

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    start(async () => {
      const r = await responder({ touchId, contactId, channel, body: texto });
      setResultado(r);
      if (r.ok) {
        setTexto("");
        setTouchId(nuevoId());
      } else if (r.field) {
        enfocarRespuesta();
      }
    });
  }

  function cancelar(p: PendienteVista, editar: boolean) {
    start(async () => {
      const r = await cancelarRespuesta({ touchId: p.touchId, editar });
      setResultado(r.ok ? { ok: true, notice: r.notice } : { ok: false, error: r.error });
      if (r.ok && editar) {
        setTexto(r.body);
        enfocarRespuesta();
      }
    });
  }

  // «Descartar» con su estado de carga y su error, como «Cancelar» y «Editar»: un clic, una vez.
  function descartar(p: PendienteVista) {
    start(async () => setResultado(await descartarRespuesta({ touchId: p.touchId })));
  }

  const error = resultado && !resultado.ok ? resultado : null;
  return (
    <div className="grid gap-4">
      <Lista titulo={t.responder.porSalir(porSalir.length)} items={porSalir}>
        {(p) =>
          p.cancelable && puedeOperar ? (
            <>
              {p.retenida ? (
                <Button size="sm" variant="ghost" href={APROBACIONES_HREF}>
                  {t.responder.irAAprobaciones}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => cancelar(p, true)} disabled={pending}>
                {t.responder.editar}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => cancelar(p, false)} disabled={pending}>
                {t.responder.cancelar}
              </Button>
            </>
          ) : null
        }
      </Lista>
      <Lista titulo={t.responder.noSalieron(noSalieron.length)} items={noSalieron}>
        {(p) =>
          puedeOperar ? (
            <Button size="sm" variant="ghost" onClick={() => descartar(p)} disabled={pending}>
              {t.responder.descartar}
            </Button>
          ) : null
        }
      </Lista>
      {!puedeOperar ? (
        <Aviso info={t.sinPermiso} />
      ) : puedeResponder ? (
        <form onSubmit={enviar} className="grid gap-3">
          <Field label={t.responder.label} help={ayuda} error={error?.field ? error.error : undefined} htmlFor={RESPUESTA_ID}>
            <Textarea
              id={RESPUESTA_ID}
              name="body"
              rows={4}
              maxLength={maxCaracteres}
              placeholder={t.responder.placeholder}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
          </Field>
          <Aviso message={error && !error.field ? error.error : null} notice={resultado?.ok ? resultado.notice : null} />
          {avisoBorrador ? <Aviso info={avisoBorrador} size="xs" /> : null}
          <div>
            <Button type="submit" variant="primary" loading={pending}>
              {t.responder.enviar}
            </Button>
          </div>
        </form>
      ) : (
        <Aviso message={error ? error.error : null} notice={resultado?.ok ? resultado.notice : null} />
      )}
    </div>
  );
}

function Lista({
  titulo, items, children,
}: { titulo: string; items: PendienteVista[]; children: (p: PendienteVista) => ReactNode }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={titulo} className="grid gap-2">
      <p className="text-xs font-medium text-ink-2">{titulo}</p>
      {items.map((p) => (
        <div key={p.touchId} className="ml-auto w-full max-w-xl rounded-md border border-dashed border-border bg-surface p-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <Pill kind={p.retenida ? "warn" : p.motivo ? "bad" : "neutral"}>{p.estado}</Pill>
            <div className="flex flex-wrap gap-2">{children(p)}</div>
          </div>
          <p className="whitespace-pre-wrap break-words text-ink-2">{p.cuerpo}</p>
          {p.motivo ? <p className="mt-1 text-xs text-ink-2">{p.motivo}</p> : null}
        </div>
      ))}
    </section>
  );
}

/**
 * «Crear contacto» desde un referido: el nombre, el correo y el cargo que
 * leyó el clasificador, editables. Nada se crea sin que una persona lo
 * pida. Creada la ficha, la acción revalida la página y el mensaje la
 * pinta con «Enrolar en una cadencia» y el enlace a la ficha
 * (conversacion.tsx): esa línea es la que queda, no este formulario.
 */
export function CrearReferido({
  messageId, nombre, correo, cargo,
}: { messageId: string; nombre: string | null; correo: string | null; cargo: string | null }) {
  const [abierto, setAbierto] = useState(false);
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (abierto) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [abierto]);

  if (resultado?.ok) return <Aviso notice={resultado.notice} size="xs" />;
  if (!abierto) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setAbierto(true)}>
        {t.referido.crear}
      </Button>
    );
  }
  const error = resultado && !resultado.ok ? resultado : null;
  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    start(async () => {
      setResultado(
        await crearReferido({
          messageId, fullName: String(d.get("fullName") ?? ""), email: String(d.get("email") ?? ""), roleTitle: String(d.get("roleTitle") ?? ""),
        }),
      );
    });
  }
  return (
    <form ref={formRef} onSubmit={enviar} className="grid gap-3 rounded-md border border-border bg-surface p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t.referido.nombre} error={error?.field === "fullName" ? error.error : undefined}>
          <Input name="fullName" defaultValue={nombre ?? ""} maxLength={200} />
        </Field>
        <Field label={t.referido.correo} error={error?.field === "email" ? error.error : undefined}>
          <Input name="email" type="email" defaultValue={correo ?? ""} maxLength={254} />
        </Field>
        <Field label={t.referido.cargo}>
          <Input name="roleTitle" defaultValue={cargo ?? ""} maxLength={200} />
        </Field>
      </div>
      <Aviso message={error && !error.field ? error.error : null} size="xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.referido.guardar}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>
          {t.referido.cancelar}
        </Button>
      </div>
    </form>
  );
}
