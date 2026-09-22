"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, LogOut, Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cambiarEspacio, cerrarSesion, crearEspacio, type EstadoEspacio } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * El menú del selector de espacio. Referencia: el conmutador de Notion
 * y el de Vercel, arriba a la izquierda —inicial en un cuadro, nombre,
 * y la lista con una marca en el actual—, porque es donde la gente ya
 * lo busca.
 *
 * Todo lo que hace pasa por server actions: el id del espacio viaja en
 * el `value` de cada botón y la membresía la comprueba el servidor
 * (lib/auth/acciones.ts). Este componente no consulta nada ni sabe
 * quién puede ver qué.
 */
export interface EspacioVisible {
  id: string;
  name: string;
}

const ESTADO: EstadoEspacio = {};

export function WorkspaceMenu({ actual, espacios }: { actual: EspacioVisible; espacios: EspacioVisible[] }) {
  const t = MESSAGES.selector;
  const [abierto, setAbierto] = useState(false);
  const [creando, setCreando] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const [estadoCambio, cambiar, cambiando] = useActionState<EstadoEspacio, FormData>(cambiarEspacio, ESTADO);
  const [estadoCreacion, crear, creandoEnvio] = useActionState<EstadoEspacio, FormData>(crearEspacio, ESTADO);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto]);

  const error = estadoCambio.error ?? estadoCreacion.error;

  return (
    <div ref={caja} className="relative">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="true"
        aria-expanded={abierto}
        aria-controls={menuId}
        aria-label={t.etiqueta}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-accent-ink"
          aria-hidden="true"
        >
          {inicial(actual.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{actual.name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      </button>

      {abierto && (
        <div
          id={menuId}
          className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{t.espacios}</p>

          <form action={cambiar}>
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {espacios.map((e) => {
                const esActual = e.id === actual.id;
                return (
                  <li key={e.id}>
                    <button
                      type="submit"
                      name="workspaceId"
                      value={e.id}
                      disabled={cambiando || esActual}
                      aria-current={esActual ? "true" : undefined}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover disabled:cursor-default"
                    >
                      <span
                        className="grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-surface-2 text-[10px] font-bold text-ink-2"
                        aria-hidden="true"
                      >
                        {inicial(e.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {esActual && <Check className="h-3.5 w-3.5 shrink-0 text-ink-2" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </form>

          <div className="my-1 h-px bg-border" />

          {creando ? (
            <form action={crear} className="flex flex-col gap-2 p-1.5">
              <Input name="nombre" aria-label={t.crearNombre} placeholder={t.crearNombre} autoFocus required maxLength={80} />
              <Button type="submit" variant="primary" size="sm" loading={creandoEnvio}>
                {creandoEnvio ? t.creando : t.crearBoton}
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreando(true)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t.crear}
            </button>
          )}

          <div className="my-1 h-px bg-border" />

          <Link
            href="/cuenta"
            onClick={() => setAbierto(false)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t.cuenta}
          </Link>

          <form action={cerrarSesion}>
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink"
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t.cerrarSesion}
            </button>
          </form>

          {error && (
            <p role="alert" className="px-2 py-1.5 text-xs text-bad">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function inicial(nombre: string): string {
  return [...nombre.trim()][0]?.toLocaleUpperCase("es") ?? "·";
}
