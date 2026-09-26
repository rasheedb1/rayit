"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { Pill, type PillKind } from "@/components/ui/pill";
import { formatInt } from "@/lib/format";
import { cancelarSeleccion, reintentarUno, type ActividadState } from "./actions";
import { MESSAGES } from "./messages";

/** Una fila ya formateada en el servidor: aquí no se calcula ni se formatea nada. */
export interface FilaVista {
  id: string;
  estado: string;
  estadoKind: PillKind;
  /** El asunto del correo, o el paso si no lleva asunto. */
  titulo: string;
  /** Qué mensaje es (el paso, o el asunto): distingue las casillas de una misma persona para un lector de pantalla. */
  queEs: string;
  contacto: string;
  /** La marca y la cadencia. */
  contexto: string;
  /** El paso, o null si ya es el título o no tiene (un toque suelto: el contexto dice «Sin cadencia»). */
  paso: string | null;
  /** Cuándo, corto (al lado de la pastilla: «24 de sept, 7:31 p. m.» o «Sale lun 28, 8:12 a. m.»), y la frase larga para el title y el detalle. */
  cuando: string;
  cuandoCompleto: string | null;
  /** «Desde laura@marca.test»: la cuenta con la que salió o se intentó. */
  cuenta: string | null;
  /** La frase del motivo (se corta en la fila cerrada) y su código para soporte (en el detalle que se despliega). */
  motivo: string | null;
  motivoCodigo: string | null;
  motivoTono: "bad" | "warn" | "muted";
  marcas: string[];
  intentos: string | null;
  reintentable: boolean;
  /** Fallido que no se puede reintentar: por qué, en vez del botón. */
  bloqueo: string | null;
  /** Fallido por la cuenta del canal, sin ninguna conectada: el enlace a la fila de ese canal en /ventas/canales, en vez del botón. */
  reconectar: string | null;
  /** Por salir, pero la cola no lo reclama (el envío apagado, el canal sin cuenta o fuera de la política): por qué y adónde ir. */
  espera: { texto: string; enlace: string; href: string } | null;
  /** Retenido: adónde ir a revisarlo y aprobarlo (la cadencia de la ficha). */
  revisar: string | null;
  cancelable: boolean;
  enviando: boolean;
  fichaHref: string;
}

const TONO = { bad: "text-bad", warn: "text-warn", muted: "text-fg-2" } as const;

/**
 * El motivo de una fila: cortado en una línea mientras está cerrado y
 * entero al abrirlo, con su código y su fecha completa. Es un
 * <details>/<summary>: se abre con el ratón, con el dedo (a 400 px no hay
 * cursor) y con Intro o Espacio desde el teclado, y un lector de pantalla
 * lo anuncia como algo que se despliega. Al pasar el cursor, el title
 * enseña la frase entera: con ratón no hace falta un clic para leerla.
 */
function Motivo({ f }: { f: FilaVista }) {
  return (
    <details className="group text-xs">
      <summary
        className={`flex min-w-0 cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink [&::-webkit-details-marker]:hidden ${TONO[f.motivoTono]}`}
        title={f.motivo ?? undefined}
      >
        <span className="sr-only">{MESSAGES.fila.motivo}: </span>
        <span className="min-w-0 truncate group-open:whitespace-normal">{f.motivo}</span>
        <ChevronDown size={12} aria-hidden className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1 flex flex-col gap-0.5 border-l border-line pl-2 text-fg-3">
        {f.motivoCodigo && <p className="font-mono">{f.motivoCodigo}</p>}
        {f.cuandoCompleto && <p className="tabular-nums">{f.cuandoCompleto}</p>}
      </div>
    </details>
  );
}

/**
 * La cola o el historial, como la lista de eventos de Stripe: una fila por
 * mensaje, con su estado, a quién, qué paso y cuándo; el motivo cortado en
 * una línea, entero al desplegarlo. En la cola, cada fila cancelable lleva
 * su casilla y la barra de arriba cancela lo seleccionado, con una
 * confirmación en el sitio; un fallido reintentable lleva su «Reintentar»,
 * uno bloqueado dice por qué, y uno cuya cuenta está caída lleva a
 * reconectarla.
 *
 * El resultado de cada acción no se pinta aquí: sube a `onResultado`
 * (PanelActividad), que lo mantiene a la vista aunque la lista se vacíe.
 */
export function ListaActividad({
  filas, seleccionable, caption, locale, soloPagina = null, onResultado,
}: {
  filas: FilaVista[];
  seleccionable: boolean;
  caption: string;
  locale: string;
  /**
   * Con más de una página: la frase que dice que la selección es solo de
   * esta página y cuántos hay con estos filtros. null con una sola página.
   */
  soloPagina?: string | null;
  onResultado: (r: ActividadState) => void;
}) {
  const [seleccion, setSeleccion] = useState<ReadonlySet<string>>(new Set());
  const [ocupada, empezar] = useTransition();
  const [reintentando, setReintentando] = useState<string | null>(null);
  const idTodas = useId();
  const cancelables = filas.filter((f) => f.cancelable).map((f) => f.id);
  const todas = cancelables.length > 0 && cancelables.every((id) => seleccion.has(id));
  const t = MESSAGES.seleccion;

  function alternar(id: string) {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function cancelar() {
    const ids = [...seleccion].filter((id) => cancelables.includes(id));
    const r = await cancelarSeleccion(ids);
    if (r.ok) setSeleccion(new Set());
    onResultado(r);
  }

  function reintentar(id: string) {
    setReintentando(id);
    empezar(async () => {
      const r = await reintentarUno(id);
      setReintentando(null);
      onResultado(r);
    });
  }

  const n = seleccion.size;
  return (
    <div className="flex flex-col gap-3">
      {seleccionable && cancelables.length > 0 && (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <label htmlFor={idTodas} className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-2">
            <input
              id={idTodas}
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={todas}
              onChange={() => setSeleccion(todas ? new Set() : new Set(cancelables))}
            />
            {n > 0 ? t.n(formatInt(n, { locale }), n) : soloPagina ? t.pagina : t.todas}
          </label>
          {n > 0 && (
            <ConfirmInline
              action={cancelar}
              label={t.cancelar}
              variant="danger"
              question={t.pregunta(formatInt(n, { locale }), n)}
              consequence={t.consecuencia}
              confirmLabel={t.confirmar}
              cancelLabel={t.volver}
              openWidth="w-full sm:w-96"
            />
          )}
          {soloPagina && n > 0 && <p className="w-full text-xs text-fg-2">{soloPagina}</p>}
        </div>
      )}
      <ul aria-label={caption} className="divide-y divide-line rounded-md border border-line bg-surface">
        {filas.map((f) => (
          <li key={f.id} className="flex items-start gap-3 px-3 py-3 sm:px-4">
            {seleccionable && (
              <span className="flex h-5 w-4 shrink-0 items-center">
                {f.cancelable ? (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    aria-label={t.una(f.contacto, f.queEs)}
                    checked={seleccion.has(f.id)}
                    onChange={() => alternar(f.id)}
                  />
                ) : f.enviando ? (
                  <span className="sr-only">{t.enviando}</span>
                ) : null}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={f.titulo}>{f.titulo}</p>
                  <p className="truncate text-xs text-fg-2">
                    <Link href={f.fichaHref} className="hover:text-fg hover:underline" title={MESSAGES.fila.verFicha}>{f.contacto}</Link>
                    <span aria-hidden="true"> · </span>
                    {f.contexto}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 sm:justify-end">
                  <Pill kind={f.estadoKind}>{f.estado}</Pill>
                  <span className="whitespace-nowrap text-xs tabular-nums text-fg-2" title={f.cuandoCompleto ?? undefined}>{f.cuando}</span>
                </div>
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-3">
                {f.paso && <span>{f.paso}</span>}
                {f.intentos && <span className="tabular-nums">{f.intentos}</span>}
                {f.cuenta && <span className="min-w-0 break-all">{f.cuenta}</span>}
                {f.marcas.map((m) => <span key={m} className="text-good">{m}</span>)}
              </p>
              {f.motivo && <Motivo f={f} />}
              {f.bloqueo && <p className="text-xs text-fg-3">{f.bloqueo}</p>}
              {f.reconectar && (
                <p className="text-xs text-fg-2">
                  {MESSAGES.reintentar.reconectar}{" "}
                  <Link href={f.reconectar} className="font-medium text-fg underline underline-offset-2">{MESSAGES.reintentar.irACanales}</Link>
                </p>
              )}
              {f.espera && (
                <p className="text-xs text-warn">
                  {f.espera.texto}{" "}
                  <Link href={f.espera.href} className="font-medium underline underline-offset-2">{f.espera.enlace}</Link>
                </p>
              )}
            </div>
            {f.reintentable && (
              <Button size="sm" variant="secondary" loading={ocupada && reintentando === f.id} disabled={ocupada} onClick={() => reintentar(f.id)}>
                {MESSAGES.reintentar.uno}
              </Button>
            )}
            {f.revisar && (
              <Button size="sm" variant="secondary" href={f.revisar}>
                {MESSAGES.fila.revisar}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
