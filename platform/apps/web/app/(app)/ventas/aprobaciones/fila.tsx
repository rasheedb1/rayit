"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { Pill } from "@/components/ui/pill";
import { aprobarToque, saltarToque, type ResultadoAprobacion } from "./actions";
import { EditarYAprobar, Fallo, Regenerar } from "./formularios";
import { MESSAGES } from "./messages";
import type { FilaVista } from "./vista";

const t = MESSAGES;

/**
 * Un mensaje retenido, en una fila: a quién va y en qué paso, el mensaje
 * completo, por qué quedó retenido y lo que se puede hacer. Cada acción
 * lleva `data-accion` (a, e, r, s): los atajos de la lista la pulsan.
 */
export function Fila({
  fila, activa, onActivar, onDone, puedeOperar = true,
}: {
  fila: FilaVista;
  activa: boolean;
  onActivar: () => void;
  onDone: (r: Extract<ResultadoAprobacion, { ok: true }>) => void;
  /** Sin PUEDEN_OPERAR_VENTAS la fila se lee: ni botones ni atajos (el servidor lo vuelve a mirar). */
  puedeOperar?: boolean;
}) {
  const [modo, setModo] = useState<"ver" | "editar" | "regenerar">("ver");
  const [pending, start] = useTransition();
  const [fallo, setFallo] = useState<Extract<ResultadoAprobacion, { ok: false }> | null>(null);
  /** Lo que no dejó aprobarlo tal cual: el editor lo abre en su campo (aria-invalid, con el foco), no en un aviso aparte. */
  const [errorInicial, setErrorInicial] = useState<Extract<ResultadoAprobacion, { ok: false }> | null>(null);
  const bloqueada = fila.regenerando || fila.motivo?.intentoSinConfirmar === true;
  /** Las cifras sin origen que no dejan aprobarlo tal cual; null si se puede. */
  const cifras = bloqueada ? null : fila.cifrasSinOrigen;
  const enfocarFila = () => document.getElementById(`fila-${fila.touchId}`)?.focus();

  async function aprobarAhora() {
    const r = await aprobarToque({ touchId: fila.touchId, edicion: null });
    if (r.ok) onDone(r);
    else if (r.errors) {
      // Algo del texto no deja aprobarlo tal cual: se abre el editor con el motivo en su campo.
      setFallo(null);
      setErrorInicial(r);
      setModo("editar");
    } else setFallo(r);
  }

  function aprobar() {
    start(aprobarAhora);
  }

  /**
   * Con una cifra sin origen el texto tal cual no sale: «Editar y aprobar»
   * (y la a) abre el editor con el motivo en su campo y la cifra señalada,
   * lo mismo que diría el servidor, sin pasar por una pregunta que promete
   * algo que no puede pasar.
   */
  function editarConCifras(lista: string[]) {
    setFallo(null);
    setErrorInicial({ ok: false, errors: { body: t.errores.unsourced_figure(lista) }, cifras: lista });
    setModo("editar");
  }

  async function saltar() {
    const r = await saltarToque({ touchId: fila.touchId });
    if (r.ok) onDone(r);
    else setFallo(r);
  }

  // Lo que salió bien cierra el formulario y el foco vuelve a la fila (j y k siguen desde ella): la fila vuelve a
  // verse, o sale de la lista al revalidar y la cola pasa el foco a la que ocupa su lugar.
  const terminar = (r: Extract<ResultadoAprobacion, { ok: true }>) => {
    setModo("ver");
    setFallo(null);
    setErrorInicial(null);
    onDone(r);
    // Después de desmontar el formulario (el foco cayó en <body>); si otro lo tomó entretanto, no se le quita.
    requestAnimationFrame(() => {
      const activo = document.activeElement;
      if (!activo || activo === document.body) enfocarFila();
    });
  };

  const volver = () => {
    setModo("ver");
    setErrorInicial(null);
    enfocarFila();
  };

  return (
    <article
      id={`fila-${fila.touchId}`}
      tabIndex={-1}
      aria-label={fila.etiqueta}
      aria-current={activa ? "true" : undefined}
      onFocus={onActivar}
      // La activa solo se marca desde sm: sin teclado (un teléfono) no hay atajos y la primera parecía elegida. El
      // foco del teclado (j, k) se ve siempre, a cualquier ancho y con zoom: el anillo de focus-visible no lleva sm.
      className={`scroll-mt-24 rounded-md border border-border bg-surface p-4 outline-none transition-colors focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/20 sm:p-5 ${
        activa ? "sm:border-ink sm:ring-2 sm:ring-ink/10" : ""
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            <Link href={fila.fichaHref} className="hover:underline">
              {fila.empresa}
            </Link>
            <span className="text-ink-2"> · {fila.persona}</span>
          </p>
          <p className="text-xs text-ink-2">
            {fila.paso} · {fila.canal}
            {fila.sale ? ` · ${fila.sale}` : ""}
          </p>
          {/* §8, decisión 5: de dónde salió el contacto, siempre a la vista antes de aprobar un primer mensaje. */}
          {fila.procedencia ? <p className="text-xs text-ink-2">{fila.procedencia}</p> : null}
        </div>
        {fila.regenerando ? <Pill kind="neutral">{t.fila.regenerando}</Pill> : null}
        {fila.regenerado ? <Pill kind="good">{t.fila.regenerado}</Pill> : null}
      </header>

      {modo === "editar" ? (
        <div className="mt-4">
          {/* El motivo va en el campo del editor (errorInicial), no repetido encima. */}
          <EditarYAprobar fila={fila} onDone={terminar} onCancel={volver} errorInicial={errorInicial} />
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-3 text-sm">
          {fila.subject && fila.conAsunto ? (
            <p className="mb-2 font-medium text-ink">
              <span className="sr-only">{t.fila.asunto}: </span>
              {fila.subject}
            </p>
          ) : null}
          {fila.hilo ? <p className="mb-2 text-xs text-ink-2">{fila.hilo}</p> : null}
          <p className="whitespace-pre-wrap break-words leading-6 text-ink">{fila.body.trim() ? fila.body : t.fila.sinTexto}</p>
        </div>
      )}

      <Porque fila={fila} />

      {modo === "regenerar" ? (
        <div className="mt-4">
          <Regenerar fila={fila} onDone={terminar} onCancel={volver} />
        </div>
      ) : null}

      {modo === "ver" && puedeOperar ? (
        <div className="mt-4 grid gap-3">
          <Fallo r={fallo} />
          {fila.motivo?.intentoSinConfirmar ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button href={fila.fichaHref}>
                {t.acciones.resolverEnLaFicha}
              </Button>
              <p className="text-xs text-ink-2">{t.acciones.resolverAyuda}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-start gap-2">
            {cifras ? (
              // Sin «Aprobar»: la a y la e llevan al editor, con la cifra señalada.
              <span data-accion="a" className="inline-flex">
                <span data-accion="e" className="inline-flex">
                  <Button variant="primary" onClick={() => editarConCifras(cifras)}>
                    {t.acciones.editar}
                  </Button>
                </span>
              </span>
            ) : null}
            {!bloqueada && !cifras ? (
              <>
                <span data-accion="a" className="inline-flex">
                  {fila.aprobarBajo ? (
                    // Por debajo del mínimo del juez: aprobarlo tal cual es una decisión, y se pregunta (la a abre la pregunta).
                    <ConfirmInline
                      action={aprobarAhora}
                      label={t.acciones.aprobar}
                      variant="primary"
                      question={fila.aprobarBajo.pregunta}
                      consequence={fila.aprobarBajo.consecuencia}
                      confirmLabel={t.acciones.aprobarBajoConfirmar}
                      cancelLabel={t.acciones.cancelar}
                      openWidth="w-full sm:w-96"
                    />
                  ) : (
                    <Button variant="primary" onClick={aprobar} loading={pending}>
                      {t.acciones.aprobar}
                    </Button>
                  )}
                </span>
                <span data-accion="e" className="inline-flex">
                  <Button variant="secondary" onClick={() => setModo("editar")}>
                    {t.acciones.editar}
                  </Button>
                </span>
              </>
            ) : null}
            {fila.regenerable ? (
              <span data-accion="r" className="inline-flex">
                <Button variant="secondary" onClick={() => setModo("regenerar")}>
                  {t.acciones.regenerar}
                </Button>
              </span>
            ) : null}
            {!fila.regenerando ? (
              <span data-accion="s" className="inline-flex">
                <ConfirmInline
                  action={saltar}
                  label={t.acciones.saltar}
                  variant="ghost"
                  question={t.acciones.saltarPregunta}
                  consequence={t.acciones.saltarConsecuencia}
                  confirmLabel={t.acciones.saltarConfirmar}
                  cancelLabel={t.acciones.cancelar}
                  openWidth="w-full sm:w-96"
                />
              </span>
            ) : null}
          </div>
          {cifras ? <p className="text-xs text-ink-2">{t.acciones.cifraSinOrigenAyuda(cifras.length)}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

/** «Por qué quedó retenido»: la regla que saltó y, si lo redactó la IA, lo que dijo su revisión. */
function Porque({ fila }: { fila: FilaVista }) {
  const m = fila.motivo;
  const j = fila.juez;
  if (!m && !j) return null;
  return (
    <section aria-label={fila.porqueTitulo} className="mt-4 grid gap-2 text-sm">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-2">{fila.porqueTitulo}</h3>
      {m ? (
        <p className="leading-6 text-ink">
          {m.etiqueta ? <span className="font-medium">{m.etiqueta}. </span> : null}
          {m.texto}
        </p>
      ) : null}
      {j ? (
        <div className="grid gap-2">
          {j.total || j.dimensiones.length > 0 ? (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              {j.total ? (
                <div className="flex gap-1">
                  <dt className="sr-only">{t.porque.notaDelJuez}</dt>
                  <dd className={`font-medium tabular-nums ${j.totalBajo ? "text-warn" : "text-ink"}`}>{j.total}</dd>
                </div>
              ) : null}
              {/* La que queda por debajo del mínimo se señala (Stripe Radar: qué regla tiró la nota). */}
              {j.dimensiones.map((d) => (
                <div key={d.key} data-bajo={d.bajo ? "" : undefined} className={`flex gap-1 ${d.bajo ? "text-warn" : ""}`}>
                  <dt>{d.label}</dt>
                  <dd className={`tabular-nums ${d.bajo ? "font-medium text-warn" : "text-ink"}`}>
                    {d.valor}
                    {d.bajo ? <span className="sr-only">, {t.porque.bajoMinimo}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {j.intentos ? <p className="text-xs text-ink-2">{j.intentos}</p> : null}
          {j.nota ? (
            <p className="leading-6 text-ink-2">
              {t.porque.notaDelJuez}: «{j.nota}»
            </p>
          ) : null}
          <Lista titulo={t.porque.riesgos} items={j.riesgos} />
          <Lista titulo={t.porque.preflight} items={j.reglas} />
        </div>
      ) : null}
    </section>
  );
}

function Lista({ titulo, items }: { titulo: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs text-ink-2">{titulo}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
