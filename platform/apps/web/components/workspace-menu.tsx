"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, LogOut, Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cambiarEspacio, cerrarSesion, crearEspacio, type EstadoEspacio } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { MAX_NOMBRE } from "@/lib/auth/reglas";
import { inicial } from "@/lib/workspace/inicial";

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
 *
 * Accesibilidad. Se anuncia como menú (`aria-haspopup="menu"`,
 * `role="menu"`) y se usa con el teclado como el de las referencias:
 *
 *   · Los espacios son `menuitemradio` dentro de un `group` con nombre,
 *     con `aria-checked` en el actual (ronda 4). Antes eran `menuitem`
 *     con `aria-current`, que no es un estado válido para ese rol, y el
 *     actual iba `disabled`: no recibía foco, las flechas lo saltaban y
 *     un lector de pantalla nunca decía cuál era. Ahora se enfoca como
 *     los demás, es el primero que recibe el foco al abrir, y elegirlo
 *     cierra el menú sin cambiar nada, como en Notion.
 *   · Flechas arriba y abajo recorren todas las opciones y dan la
 *     vuelta; Escape cierra y devuelve el foco al disparador; Tab cierra
 *     y deja que el foco siga su camino.
 *   · «Crear espacio» ya NO vive dentro del `role="menu"` (ronda 4): un
 *     campo de texto no es una opción de menú, y el manejador de teclado
 *     del menú se comía su Tab —cerraba el panel y se perdía lo escrito,
 *     así que el botón «Crear» no se alcanzaba nunca con el teclado— y
 *     sus flechas. Al pulsarlo, el panel cambia a un formulario propio
 *     (`role="group"` con nombre) con Crear y Cancelar: ahí Tab y las
 *     flechas son las del navegador, y Escape vuelve a la lista con el
 *     foco en «Crear espacio».
 *
 * Con qué correo se entró se ve bajo «Tu cuenta» (como en Vercel y
 * Linear). Sin eso, quien abre un enlace mágico que pidió otra persona
 * para SU correo trabajaría dentro de la cuenta ajena sin notarlo: el
 * selector solo enseñaba el nombre del espacio.
 */
export interface EspacioVisible {
  id: string;
  name: string;
}

const ESTADO: EstadoEspacio = {};

const SELECTOR_OPCIONES = '[role="menuitem"], [role="menuitemradio"]';

export function WorkspaceMenu({
  actual,
  espacios,
  correo,
}: {
  actual: EspacioVisible;
  espacios: EspacioVisible[];
  /** El correo de la sesión. */
  correo: string;
}) {
  const t = MESSAGES.selector;
  const [abierto, setAbierto] = useState(false);
  const [creando, setCreando] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const disparador = useRef<HTMLButtonElement>(null);
  const botonCrear = useRef<HTMLButtonElement>(null);
  /** Al volver de «Crear espacio» con Escape o Cancelar, el foco va a su botón y no al primero de la lista. */
  const volverACrear = useRef(false);
  const panelId = useId();
  const tituloGrupo = useId();
  const tituloCrear = useId();

  const [estadoCambio, cambiar, cambiando] = useActionState<EstadoEspacio, FormData>(cambiarEspacio, ESTADO);
  const [estadoCreacion, crear, creandoEnvio] = useActionState<EstadoEspacio, FormData>(crearEspacio, ESTADO);

  /** Las opciones del menú, en el orden en que se ven. Todas enfocables, también la actual. */
  const opciones = useCallback((): HTMLElement[] => {
    const nodos = panel.current?.querySelectorAll<HTMLElement>(SELECTOR_OPCIONES);
    return nodos ? [...nodos] : [];
  }, []);

  const cerrar = useCallback((devolverFoco: boolean) => {
    setAbierto(false);
    setCreando(false);
    if (devolverFoco) disparador.current?.focus();
  }, []);

  const salirDeCrear = useCallback(() => {
    volverACrear.current = true;
    setCreando(false);
  }, []);

  // Al abrir (o al volver de «Crear espacio»), el foco entra en el menú:
  // en el espacio actual, que es lo primero que alguien quiere oír, o en
  // «Crear espacio» si se viene de ahí.
  useEffect(() => {
    if (!abierto || creando) return;
    if (volverACrear.current) {
      volverACrear.current = false;
      botonCrear.current?.focus();
      return;
    }
    const lista = opciones();
    (lista.find((o) => o.getAttribute("aria-checked") === "true") ?? lista[0])?.focus();
  }, [abierto, creando, opciones]);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: globalThis.MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) cerrar(false);
    };
    const teclado = (e: KeyboardEvent) => {
      if (creando) {
        // En el formulario de crear, el teclado es del navegador: Tab
        // llega a «Crear» y a «Cancelar», y las flechas mueven el cursor
        // del campo. Solo Escape es nuestro, y vuelve a la lista.
        if (e.key === "Escape") {
          e.preventDefault();
          salirDeCrear();
        }
        return;
      }
      if (e.key === "Escape") {
        cerrar(true);
        return;
      }
      // Tab sale del menú: se cierra y el foco sigue su camino natural
      // (no se devuelve al disparador, que sería atrapar a quien tabula).
      if (e.key === "Tab") {
        cerrar(false);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const lista = opciones();
      if (lista.length === 0) return;
      const actualIdx = lista.indexOf(document.activeElement as HTMLElement);
      const paso = e.key === "ArrowDown" ? 1 : -1;
      const siguiente = actualIdx === -1 ? 0 : (actualIdx + paso + lista.length) % lista.length;
      e.preventDefault();
      lista[siguiente]?.focus();
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", teclado);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", teclado);
    };
  }, [abierto, creando, cerrar, opciones, salirDeCrear]);

  /**
   * Elegir el espacio en el que ya estás cierra el menú sin enviar nada
   * (Notion hace lo mismo). Mientras otro cambio está en camino, ninguna
   * opción envía: van `aria-disabled` y no `disabled`, para que sigan
   * enfocables y el lector de pantalla las siga anunciando.
   */
  const alElegir = (esActual: boolean) => (e: MouseEvent<HTMLButtonElement>) => {
    if (cambiando) {
      e.preventDefault();
      return;
    }
    if (esActual) {
      e.preventDefault();
      cerrar(true);
    }
  };

  const error = estadoCambio.error ?? estadoCreacion.error;
  const soporte = estadoCambio.error ? undefined : estadoCreacion.soporte;

  return (
    <div
      ref={caja}
      className="relative"
      // Si el foco sale del selector por su cuenta (Tab desde «Cancelar»
      // en el formulario de crear), el panel se cierra: un menú abierto
      // con el foco en otra parte no se puede cerrar sin ratón.
      onBlur={(e) => {
        const destino = e.relatedTarget as Node | null;
        if (abierto && destino && !caja.current?.contains(destino)) cerrar(false);
      }}
    >
      <button
        ref={disparador}
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls={abierto ? panelId : undefined}
        aria-label={t.disparador(actual.name)}
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
          ref={panel}
          id={panelId}
          className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {creando ? (
            <form action={crear} role="group" aria-labelledby={tituloCrear} className="flex flex-col gap-2 p-1.5">
              <p id={tituloCrear} className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                {t.crear}
              </p>
              <Input
                name="nombre"
                aria-label={t.crearNombre}
                placeholder={t.crearNombre}
                autoFocus
                required
                maxLength={MAX_NOMBRE}
              />
              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" size="sm" loading={creandoEnvio}>
                  {creandoEnvio ? t.creando : t.crearBoton}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={salirDeCrear}>
                  {t.cancelar}
                </Button>
              </div>
            </form>
          ) : (
            <div role="menu" aria-label={t.etiqueta}>
              <p id={tituloGrupo} role="none" className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                {t.espacios}
              </p>

              <form action={cambiar} role="none">
                <ul role="group" aria-labelledby={tituloGrupo} className="max-h-64 space-y-0.5 overflow-y-auto">
                  {espacios.map((e) => {
                    const esActual = e.id === actual.id;
                    return (
                      <li key={e.id} role="none">
                        <button
                          type="submit"
                          role="menuitemradio"
                          aria-checked={esActual}
                          aria-disabled={cambiando || undefined}
                          name="workspaceId"
                          value={e.id}
                          onClick={alElegir(esActual)}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover focus-visible:bg-hover aria-disabled:cursor-progress"
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

              <div role="separator" className="my-1 h-px bg-border" />

              <button
                ref={botonCrear}
                type="button"
                role="menuitem"
                onClick={() => setCreando(true)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t.crear}
              </button>

              <div role="separator" className="my-1 h-px bg-border" />

              <Link
                href="/cuenta"
                role="menuitem"
                onClick={() => cerrar(false)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover"
              >
                <User className="h-3.5 w-3.5 shrink-0 self-start mt-0.5" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{t.cuenta}</span>
                  <span className="truncate text-xs text-muted" title={correo}>
                    {t.sesionComo(correo)}
                  </span>
                </span>
              </Link>

              <form action={cerrarSesion} role="none">
                <button
                  type="submit"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover"
                >
                  <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t.cerrarSesion}
                </button>
              </form>
            </div>
          )}

          {error && (
            <p role="alert" className="px-2 py-1.5 text-xs text-bad">
              {error}
              {soporte && (
                <>
                  {" "}
                  {t.errores.limiteContacto}{" "}
                  <a href={`mailto:${soporte}`} className="break-all font-medium underline underline-offset-2">
                    {soporte}
                  </a>
                  .
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
