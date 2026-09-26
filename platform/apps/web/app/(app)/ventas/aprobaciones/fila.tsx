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
  fila, activa, onActivar, onDone,
}: { fila: FilaVista; activa: boolean; onActivar: () => void; onDone: (notice: string) => void }) {
  const [modo, setModo] = useState<"ver" | "editar" | "regenerar">("ver");
  const [pending, start] = useTransition();
  const [fallo, setFallo] = useState<Extract<ResultadoAprobacion, { ok: false }> | null>(null);
  const bloqueada = fila.regenerando || fila.motivo?.intentoSinConfirmar === true;

  function aprobar() {
    start(async () => {
      const r = await aprobarToque({ touchId: fila.touchId, persona: fila.persona, edicion: null });
      if (r.ok) onDone(r.notice);
      else if (r.errors) {
        // Algo del texto no deja aprobarlo tal cual: se abre el editor con el motivo.
        setFallo({ ok: false, message: r.errors.body ?? r.errors.subject });
        setModo("editar");
      } else setFallo(r);
    });
  }

  async function saltar() {
    const r = await saltarToque({ touchId: fila.touchId, persona: fila.persona });
    if (r.ok) onDone(r.notice);
    else setFallo(r);
  }

  // Lo que salió bien cierra el formulario: la fila vuelve a verse (o sale de la lista al revalidar).
  const terminar = (notice: string) => {
    setModo("ver");
    setFallo(null);
    onDone(notice);
  };

  const volver = () => {
    setModo("ver");
    document.getElementById(`fila-${fila.touchId}`)?.focus();
  };

  return (
    <article
      id={`fila-${fila.touchId}`}
      tabIndex={-1}
      aria-label={t.fila.label(fila.empresa, fila.persona)}
      aria-current={activa ? "true" : undefined}
      onFocus={onActivar}
      className={`scroll-mt-24 rounded-md border bg-surface p-4 outline-none transition-colors sm:p-5 ${
        activa ? "border-ink ring-2 ring-ink/10" : "border-border"
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
        </div>
        {fila.regenerando ? <Pill kind="neutral">{t.fila.regenerando}</Pill> : null}
        {fila.regenerado ? <Pill kind="good">{t.fila.regenerado}</Pill> : null}
      </header>

      {modo === "editar" ? (
        <div className="mt-4">
          <Fallo r={fallo} />
          <EditarYAprobar fila={fila} onDone={terminar} onCancel={volver} />
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

      {modo === "ver" ? (
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
            {!bloqueada ? (
              <>
                <span data-accion="a" className="inline-flex">
                  <Button variant="primary" onClick={aprobar} loading={pending}>
                    {t.acciones.aprobar}
                  </Button>
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
    <section aria-label={t.porque.title} className="mt-4 grid gap-2 text-sm">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-2">{t.porque.title}</h3>
      {m ? (
        <p className="leading-6 text-ink">
          <span className="font-medium">{m.etiqueta}.</span> {m.texto}
        </p>
      ) : null}
      {j ? (
        <div className="grid gap-2">
          {j.total || j.dimensiones.length > 0 ? (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              {j.total ? (
                <div className="flex gap-1">
                  <dt className="sr-only">{t.porque.notaDelJuez}</dt>
                  <dd className="font-medium tabular-nums text-ink">{j.total}</dd>
                </div>
              ) : null}
              {j.dimensiones.map((d) => (
                <div key={d.key} className="flex gap-1">
                  <dt>{d.label}</dt>
                  <dd className="tabular-nums text-ink">{d.valor}</dd>
                </div>
              ))}
              {j.intentos ? <div>{j.intentos}</div> : null}
            </dl>
          ) : null}
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
