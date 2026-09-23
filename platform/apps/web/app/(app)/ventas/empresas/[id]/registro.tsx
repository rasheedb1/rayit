"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { ACTIVITY_BODY_MAX } from "@mc/core";
import type { LoggableActivityKind } from "@mc/db/queries/ventas-ficha";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { CerrarPendiente } from "../../_seguimiento/cerrar-pendiente";
import type { SeguimientoContexto, SiguienteAccionData } from "../../_seguimiento/datos";
import { registrarActividad, type AccionPendiente, type RegistroState } from "../actions";
import { FICHA } from "../messages";
import { abrirBloqueDe } from "./bloque";

const ORDEN: LoggableActivityKind[] = ["note", "call", "email_sent", "meeting"];
/**
 * Las teclas que eligen el tipo sin tocar el ratón, como en Superhuman.
 * Salen de messages.ts (FICHA.actividad.teclas), junto a los nombres que
 * explican: al traducir la interfaz, la tecla y su texto cambian juntos.
 */
const TECLAS = new Map(ORDEN.map((k) => [FICHA.actividad.teclas[k].toLowerCase(), k]));
/** «N nota · L llamada · C correo · R reunión», construido con las mismas teclas. */
const TECLAS_TEXTO = ORDEN.map((k) => `${FICHA.actividad.teclas[k].toUpperCase()} ${FICHA.tiposManuales[k].toLowerCase()}`).join(" · ");
const TECLAS_ARIA = ORDEN.map((k) => FICHA.actividad.teclas[k].toUpperCase()).join(" ");

/** ¿El foco está en un sitio donde la letra se escribe? Entonces no es un atajo. */
function escribiendo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * El registro rápido de la ficha (VEN-5): nota, llamada, correo o
 * reunión, con el teclado de principio a fin.
 *
 *   · N, L, C o R eligen el tipo y ponen el cursor en «Qué pasó», pero
 *     SOLO con el foco dentro del bloque «Actividad» (su título, el
 *     selector de tipo, los botones del formulario) y fuera de un campo
 *     de texto. Un atajo de una letra puesto en toda la página se
 *     disparaba con el foco en cualquier botón o enlace («Cambiar» de un
 *     negocio + R cambiaba el tipo y robaba el foco), y eso incumple WCAG
 *     2.1.4 (Character Key Shortcuts): quien dicta por voz o navega con
 *     las teclas del lector de pantalla lo activa sin querer. Como en
 *     Superhuman, el atajo vale en la vista activa. Si el bloque está
 *     plegado (el foco en su título), la tecla lo abre antes de enfocar.
 *   · ⌘ o Ctrl + Enter registra desde el texto.
 *
 * Una llamada, un correo o una reunión son hablar con la marca: mueven el
 * último contacto del negocio elegido o, si no se elige, de todos los
 * abiertos (lo decide logActivity en la base). Al registrar, el texto se
 * vacía, el tipo se queda y el aviso lo dice; la actividad aparece arriba
 * de la línea de tiempo cuando la ficha se revalida.
 *
 * Si ese contacto cae en un negocio con la siguiente acción vencida o de
 * hoy, debajo del aviso se pregunta «¿Era “…”?» con «Marcarla hecha», que
 * la cierra y abre aquí mismo el editor de la siguiente (CerrarPendiente).
 */
export function RegistroRapido({
  companyId,
  deals,
  contacts,
  today,
  siguientes,
  ctx,
}: {
  companyId: string;
  /**
   * Los negocios de la empresa, los abiertos primero. `label` es solo el
   * nombre del negocio; su etapa va aparte (`stage`) y se lee debajo del
   * campo al elegirlo: en la opción cortaba el texto aun a 1400 px.
   */
  deals: { id: string; label: string; stage: string; open: boolean }[];
  /** Los contactos a los que se les puede atribuir (los que no pidieron la baja). */
  contacts: { id: string; label: string }[];
  /** Hoy en la zona del espacio: el valor por defecto y el máximo de «Cuándo». */
  today: string;
  /**
   * La siguiente acción de cada negocio abierto, ya formateada (la misma
   * que pinta la lista de negocios), y el contexto del editor: con ellos se
   * propone marcar hecha la acción pendiente. Sin ellos, no se propone.
   */
  siguientes?: Record<string, SiguienteAccionData>;
  ctx?: SeguimientoContexto;
}) {
  const t = FICHA.actividad;
  const [kind, setKind] = useState<LoggableActivityKind>("note");
  const [occurredOn, setOccurredOn] = useState(today);
  const [notice, setNotice] = useState<string | undefined>();
  /** Las acciones pendientes que el último registro pudo haber cumplido. */
  const [pendientes, setPendientes] = useState<AccionPendiente[]>([]);
  const bodyId = `registro-${companyId}-body`;
  // RegistroState es VentasState con `pendientes` opcional: el hook lo
  // acepta tal cual y aquí se lee con su tipo.
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(registrarActividad, (s: RegistroState) => {
    setNotice(s.notice);
    setOccurredOn(today);
    setPendientes(s.pendientes ?? []);
  });

  const abiertos = deals.filter((d) => d.open);
  // Con un solo negocio abierto, la actividad es de ese. Con varios, la
  // persona elige; sin elegir, una llamada cuenta para todos los abiertos.
  const dealDefault = abiertos.length === 1 ? (abiertos[0]?.id ?? "") : "";
  const [dealId, setDealId] = useState(dealDefault);
  // Si la ficha se revalida y cambia el negocio que se propone (se cerró
  // el único abierto), el campo lo sigue.
  useEffect(() => setDealId(dealDefault), [dealDefault]);
  const elegido = deals.find((d) => d.id === dealId);
  const dealHelp = [elegido ? t.dealStage(elegido.stage) : null, kind === "note" ? null : t.dealHelp].filter(Boolean).join(" ");

  useEffect(() => {
    // El ámbito del atajo: la sección que envuelve el registro (el bloque
    // «Actividad» de la ficha) o, montado suelto, el propio formulario.
    const form = formRef.current;
    const ambito: HTMLElement | null = form?.closest("section") ?? form;
    if (!ambito) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || escribiendo(event.target)) return;
      const next = TECLAS.get(event.key.toLowerCase());
      if (!next) return;
      event.preventDefault();
      setKind(next);
      // Plegado, el textarea no se ve y focus() no haría nada: se abre antes.
      abrirBloqueDe(form);
      document.getElementById(bodyId)?.focus();
    }
    ambito.addEventListener("keydown", onKey);
    return () => ambito.removeEventListener("keydown", onKey);
  }, [bodyId, formRef]);

  function onBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <>
    <form
      ref={formRef}
      onSubmit={(e) => {
        setNotice(undefined);
        setPendientes([]);
        onSubmit(e);
      }}
      noValidate
      aria-label={t.composerLabel}
      aria-keyshortcuts={TECLAS_ARIA}
      className="rounded-md border border-border bg-surface p-3"
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="occurredOn" value={occurredOn} />

      <Segmented
        label={t.kindLabel}
        size="sm"
        value={kind}
        onChange={setKind}
        options={ORDEN.map((k) => ({ value: k, label: FICHA.tiposManuales[k] }))}
      />

      <Field label={t.body} error={errors.body} required={kind === "note"} htmlFor={bodyId} className="mt-3">
        <Textarea
          name="body"
          rows={3}
          maxLength={ACTIVITY_BODY_MAX}
          placeholder={t.bodyPlaceholder[kind]}
          onKeyDown={onBodyKeyDown}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        />
      </Field>

      {/* «Negocio» va en su propia fila y «Con quién» y «Cuándo» debajo:
          en una fila de cuatro, la opción elegida («Renovación Q4 · 3
          meses · En conversación») se cortaba aun a 1400 px. La opción
          lleva solo el nombre; la etapa se lee en la ayuda al elegirlo. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label={t.deal}
          help={dealHelp || undefined}
          error={errors.dealId}
          htmlFor={`registro-${companyId}-deal`}
          className="sm:col-span-2"
        >
          <Select
            name="dealId"
            value={dealId}
            onChange={(e) => setDealId(e.target.value)}
            placeholder={kind === "note" || abiertos.length === 0 ? t.dealNone : t.dealAll}
            options={deals.map((d) => ({ value: d.id, label: d.label }))}
          />
        </Field>
        <Field label={t.contact} error={errors.contactId} htmlFor={`registro-${companyId}-contact`}>
          <Select name="contactId" defaultValue="" placeholder={t.contactNone} options={contacts.map((c) => ({ value: c.id, label: c.label }))} />
        </Field>
        <Field label={t.occurredOn} error={errors.occurredOn} htmlFor={`registro-${companyId}-date`}>
          <DateInput value={occurredOn} max={today} onChange={setOccurredOn} />
        </Field>
      </div>

      <Aviso message={state.message} notice={notice} className="mt-3" />


      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <span className="text-xs text-muted">{t.shortcut}</span>
        <span className="hidden text-xs text-muted sm:inline">{t.keys(TECLAS_TEXTO)}</span>
      </div>
    </form>
    {/* Fuera del <form> del registro: «Marcarla hecha» y el editor de la
        siguiente son formularios propios, y un formulario no va dentro de
        otro. La región está siempre montada para que el lector de
        pantalla anuncie la pregunta cuando aparece. */}
    {ctx && siguientes && (
      // empty:mt-0: una pregunta cuya acción ya cambió se esconde (CerrarPendiente
      // devuelve null) y la región vacía no deja un hueco.
      <div aria-live="polite" className={pendientes.length > 0 ? "mt-3 space-y-2 empty:mt-0" : undefined}>
        {pendientes.flatMap((p) => {
          const data = siguientes[p.dealId];
          if (!data) return [];
          return [
            <CerrarPendiente
              key={p.dealId}
              action={p.action}
              dealName={abiertos.length > 1 ? (deals.find((d) => d.id === p.dealId)?.label ?? null) : null}
              data={data}
              ctx={ctx}
              onClose={(msg) => {
                setPendientes((prev) => prev.filter((x) => x.dealId !== p.dealId));
                if (msg) setNotice(msg);
              }}
            />,
          ];
        })}
      </div>
    )}
    </>
  );
}
