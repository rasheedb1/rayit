"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill, type PillKind } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { deshacerEntendido, entenderAviso } from "./actions";
import { MESSAGES } from "./messages";
import { MarcoSemana, TITULO_SEMANA_ID } from "./semana-marco";
import type { Enlace } from "./_lib/semana";

/**
 * La lista de «Lo que importa esta semana» (RES-3), ya con las palabras
 * y las cifras formateadas en el servidor (semana.tsx). Cliente por tres
 * cosas que el servidor no puede hacer:
 *
 *   1 · Plegar: se ven las primeras FILAS_A_LA_VISTA y el resto tras
 *       «Ver N más». Con veinte seguimientos vencidos, las cifras que dan
 *       nombre a la página no pueden quedar dos pantallas más abajo.
 *   2 · Deshacer: tras «Entendido» la fila se va al momento, sin
 *       esperar al servidor (no hay estado de carga que enseñar: si falla,
 *       la fila vuelve con el error), y queda un aviso «Quitado de tu
 *       lista» con «Deshacer» (role=status: el lector de pantalla lo
 *       anuncia). Un clic por error no esconde un cobro vencido. Y si se
 *       navega sin deshacer, una cuenta que sigue rota vuelve sola a la
 *       semana (el barrido de oauth.refresh, RES-3).
 *   3 · El foco: tras «Entendido», al «Entendido» de la fila siguiente
 *       (o de la anterior, si era la última), y al título del bloque si
 *       ya no queda ninguna. Tras «Deshacer», a la fila que vuelve.
 */

export interface FilaVista {
  /** notification.id: lo que marcan «Entendido» y «Deshacer». */
  id: string;
  fuente: string;
  pill: PillKind;
  plataforma: string | null;
  /** De quién es la cuenta o el video, cuando el espacio tiene más de una creadora; null si solo hay una. */
  quien: string | null;
  titulo: string;
  detalle: string;
  principal: Enlace;
  secundario: Enlace | null;
}

type Aviso = { tipo: "quitado"; fila: FilaVista } | { tipo: "devuelto"; fila: FilaVista } | { tipo: "error"; texto: string };

const TITULO = Symbol("titulo");

export function ListaSemana({
  filas,
  more,
  aLaVista,
  numeros,
}: {
  filas: readonly FilaVista[];
  /** La consulta dejó filas fuera (más de MAX_HIGHLIGHTS). */
  more: boolean;
  /** Cuántas se ven sin desplegar. */
  aLaVista: number;
  /**
   * Los números de 0 a filas.length ya formateados con el locale del
   * espacio (lib/format.ts, en el servidor): una función no cruza al
   * cliente, y el contador cambia aquí, tras cada «Entendido».
   */
  numeros: readonly string[];
}) {
  const t = MESSAGES.semana;
  const [quitadas, setQuitadas] = useState<ReadonlySet<string>>(() => new Set());
  const [abierto, setAbierto] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [foco, setFoco] = useState<string | typeof TITULO | null>(null);
  const [, startTransition] = useTransition();
  const raiz = useRef<HTMLDivElement>(null);
  const listaId = useId();

  const quedan = filas.filter((f) => !quitadas.has(f.id));
  const mostradas = abierto ? quedan : quedan.slice(0, aLaVista);
  const plegadas = quedan.length - mostradas.length;
  const num = (n: number) => numeros[n] ?? String(n);
  // Con `more` hay más de las que llegaron: tras cada «Entendido» siguen
  // siendo más que las que quedan aquí, y el contador baja igual que sin él.
  const meta =
    quedan.length === 0 ? undefined : more ? t.pendientesMas(num(quedan.length)) : t.pendientes(quedan.length, num(quedan.length));

  // El foco se mueve DESPUÉS de pintar: la fila de destino puede llegar en
  // el render siguiente (la que vuelve con «Deshacer» la trae el servidor).
  useEffect(() => {
    if (foco === null) return;
    const el =
      foco === TITULO
        ? document.getElementById(TITULO_SEMANA_ID)
        : raiz.current?.querySelector<HTMLElement>(`button[name="entendido"][value="${foco}"]`);
    if (el) {
      el.focus();
      setFoco(null);
    }
    // `filas` también: la fila de destino puede llegar con el siguiente render del servidor.
  }, [foco, filas, quitadas, abierto]);

  const cambiar = (s: ReadonlySet<string>, id: string, quitar: boolean) => {
    const n = new Set(s);
    if (quitar) n.add(id);
    else n.delete(id);
    return n;
  };

  function entender(fila: FilaVista) {
    const i = mostradas.findIndex((f) => f.id === fila.id);
    const vecina = mostradas[i + 1] ?? mostradas[i - 1] ?? null;
    setQuitadas((s) => cambiar(s, fila.id, true));
    setAviso({ tipo: "quitado", fila });
    setFoco(vecina ? vecina.id : TITULO);
    startTransition(async () => {
      const ok = await entenderAviso(fila.id).catch(() => false);
      if (!ok) {
        setQuitadas((s) => cambiar(s, fila.id, false));
        setAviso({ tipo: "error", texto: t.errorEntendido });
        setFoco(fila.id);
      }
    });
  }

  function deshacer(fila: FilaVista) {
    setQuitadas((s) => cambiar(s, fila.id, false));
    setAviso({ tipo: "devuelto", fila });
    setFoco(fila.id);
    startTransition(async () => {
      const ok = await deshacerEntendido(fila.id).catch(() => false);
      if (!ok) setAviso({ tipo: "error", texto: t.errorDeshacer });
    });
  }

  return (
    <MarcoSemana meta={meta} descripcion={quedan.length > 0 ? t.descripcion : undefined}>
      <div ref={raiz}>
        {quedan.length === 0 ? (
          <Vacio />
        ) : (
          <ul id={listaId} className="divide-y divide-line rounded-md border border-line">
            {mostradas.map((f) => (
              <Fila key={f.id} fila={f} onEntendido={() => entender(f)} />
            ))}
          </ul>
        )}
        {(plegadas > 0 || (abierto && quedan.length > aLaVista)) && (
          <button
            type="button"
            aria-expanded={abierto}
            aria-controls={listaId}
            onClick={() => setAbierto((a) => !a)}
            className="mt-2 rounded text-xs font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            {abierto ? t.verMenos : t.verMas(plegadas, num(plegadas))}
          </button>
        )}
        {more && quedan.length > 0 && <p className="mt-2 text-xs text-fg-3">{t.hayMas}</p>}
        <div role="status" aria-live="polite" className="mt-2 flex empty:mt-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
          {aviso?.tipo === "quitado" && (
            <>
              <span>{t.quitado(aviso.fila.titulo)}</span>
              <Button size="sm" variant="ghost" aria-label={t.deshacerDe(aviso.fila.titulo)} onClick={() => deshacer(aviso.fila)}>
                {t.deshacer}
              </Button>
            </>
          )}
          {aviso?.tipo === "devuelto" && <span>{t.devuelto(aviso.fila.titulo)}</span>}
          {aviso?.tipo === "error" && <span className="text-bad">{aviso.texto}</span>}
        </div>
      </div>
    </MarcoSemana>
  );
}

function Fila({ fila, onEntendido }: { fila: FilaVista; onEntendido: () => void }) {
  const t = MESSAGES.semana;
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Pill kind={fila.pill}>{fila.fuente}</Pill>
          {fila.plataforma && <PlatformPill platformId={fila.plataforma} />}
          {fila.quien && <span className="text-xs text-fg-2 [overflow-wrap:anywhere]">{fila.quien}</span>}
        </div>
        <p className="mt-1.5 text-sm font-medium text-ink [overflow-wrap:anywhere]">{fila.titulo}</p>
        <p className="mt-0.5 text-xs text-fg-3 tabular-nums [overflow-wrap:anywhere]">{fila.detalle}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <EnlaceFila enlace={fila.principal} de={fila.titulo} principal />
        {fila.secundario && <EnlaceFila enlace={fila.secundario} de={fila.titulo} />}
        <Button
          size="sm"
          variant="ghost"
          name="entendido"
          value={fila.id}
          aria-label={t.entendidoDe(fila.titulo)}
          onClick={onEntendido}
        >
          {t.entendido}
        </Button>
      </div>
    </li>
  );
}

/**
 * El enlace de la fila. Dentro de On Cue, el Button del kit con href. El
 * video en su red sale de la aplicación: un <a> en pestaña aparte, sin
 * opener, con el mismo aspecto que el botón (el kit no tiene uno externo).
 *
 * Su nombre accesible lleva el título de la fila (`de`), como el
 * «Entendido»: con tres seguimientos vencidos, quien salta por la lista
 * de enlaces no oye «Ver en Ventas» tres veces sin saber de cuál. Empieza
 * por el texto visible, para que quien le habla al lector por voz lo
 * pueda nombrar igual. Con aria-label y no aria-describedby: el Button
 * del kit solo deja pasar aria-label.
 */
function EnlaceFila({ enlace, de, principal = false }: { enlace: Enlace; de: string; principal?: boolean }) {
  const nombre = MESSAGES.semana.enlaceDe(enlace.label, de);
  if (!enlace.externo) {
    return principal ? (
      <Button size="sm" href={enlace.href} aria-label={nombre}>
        {enlace.label}
      </Button>
    ) : (
      <Link href={enlace.href} aria-label={nombre} className="text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline">
        {enlace.label}
      </Link>
    );
  }
  return (
    <a
      href={enlace.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={nombre}
      className={
        principal
          ? "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-axis hover:bg-hover"
          : "inline-flex items-center gap-1 text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
      }
    >
      <span className="[overflow-wrap:anywhere]">{enlace.label}</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/**
 * Sin nada que atender: una línea y no la caja punteada de EmptyState a
 * tamaño completo, que en el caso más común empujaba los KPI hacia abajo.
 * El texto no afirma nada sobre los datos (ver messages.ts › vacio).
 */
function Vacio() {
  const t = MESSAGES.semana.vacio;
  return (
    <p className="flex items-start gap-2 rounded-md border border-line px-4 py-2.5 text-xs text-fg-3">
      <Check className="mt-px h-3.5 w-3.5 shrink-0 text-good" aria-hidden="true" />
      <span>
        <span className="font-medium text-ink">{t.title}.</span> {t.description}
      </span>
    </p>
  );
}
