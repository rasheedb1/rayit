"use client";

import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActividadState } from "./actions";
import { ListaActividad, type FilaVista } from "./lista";
import { ReintentarPorTipo, type TipoReintentable } from "./reintentar";

/** Lo que dice la pantalla cuando no hay filas. */
export interface VacioVista {
  titulo: string;
  descripcion: string;
  accion?: { label: string; href: string };
}

/**
 * La parte viva de /ventas/actividad: el reintento por tipo, la lista (o
 * su vacío) y, entre los dos, el aviso de lo que hizo la última acción.
 *
 * El aviso vive aquí y no en la lista porque una acción puede vaciarla:
 * al cancelar lo último de la cola, o al reintentar el último fallido, la
 * página se vuelve a pintar con el vacío en lugar de la lista, y un aviso
 * de la lista se iba con ella («3 mensajes cancelados» desaparecía y el
 * foco caía al <body>). Este componente sigue montado con los mismos
 * filtros (la página le pone de `key` su URL), así que el aviso
 * sobrevive a la revalidación; y tras cada acción el foco va al aviso,
 * para que quien usa el teclado o un lector sepa qué pasó y siga desde
 * ahí.
 */
export function PanelActividad({
  tipos, ayudaReintento, consecuenciaReintento, sequenceId, contact, filas, seleccionable, caption, locale, soloPagina = null, vacio,
}: {
  /** Los botones de reintento por tipo; null en el historial. */
  tipos: TipoReintentable[] | null;
  /** La ayuda del reintento por tipo (cambia con el envío apagado). */
  ayudaReintento?: string;
  /** Lo que dice la pregunta del reintento por tipo (cambia con el envío apagado). */
  consecuenciaReintento?: string;
  /** Con más de una página, la frase de que la selección es solo de esta (ListaActividad). */
  soloPagina?: string | null;
  sequenceId: string | null;
  contact: string | null;
  filas: FilaVista[];
  seleccionable: boolean;
  caption: string;
  locale: string;
  vacio: VacioVista;
}) {
  const [aviso, setAviso] = useState<ActividadState & { vez: number }>({ vez: 0 });
  const avisoRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (aviso.vez > 0) avisoRef.current?.focus();
  }, [aviso.vez]);

  const onResultado = (r: ActividadState) => setAviso((prev) => ({ ...r, vez: prev.vez + 1 }));

  return (
    <div className="flex flex-col gap-3">
      {tipos && (
        <ReintentarPorTipo tipos={tipos} sequenceId={sequenceId} contact={contact} ayuda={ayudaReintento}
          consecuencia={consecuenciaReintento} onResultado={onResultado} />
      )}
      <p
        ref={avisoRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={`rounded-sm text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ink ${aviso.error ? "text-bad" : "text-fg-2"} ${aviso.error || aviso.ok ? "" : "sr-only"}`}
      >
        {aviso.error ?? aviso.ok ?? ""}
      </p>
      {filas.length === 0 ? (
        <EmptyState title={vacio.titulo} description={vacio.descripcion} action={vacio.accion} />
      ) : (
        <ListaActividad
          filas={filas}
          seleccionable={seleccionable}
          caption={caption}
          locale={locale}
          soloPagina={soloPagina}
          onResultado={onResultado}
        />
      )}
    </div>
  );
}
