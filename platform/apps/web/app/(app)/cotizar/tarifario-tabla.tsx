"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { calcularItem, MODIFICADORES_POR_DEFECTO, pctToRate, rateToPct, type EntradaTarifa, type PlatformId } from "@mc/core";
import type { RateCardInputs } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { CellMain } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Pill } from "@/components/ui/pill";
import { PLATFORM_LABEL, PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type FormatSettings, type Formatter } from "@/lib/format";
import type { ActionState } from "@/lib/forms";
import { guardarTarifario } from "./actions";
import { MESSAGES, nombreEntregable, nombreModificador } from "./messages";
import {
  construirFilas, construirPaquetes, ENTREGABLES, explicarPasos, motivoRangoManual, precioDe, textoMotivo,
  type BasisTarifario,
} from "./_lib/tarifario";
import { TablaConDetalle, type ColumnaConDetalle } from "./_ui/tabla-con-detalle";

export interface TarifarioTablaProps {
  creatorId: string;
  inputs: RateCardInputs;
  basisInicial: BasisTarifario;
  settings: FormatSettings;
  /** true cuando el tarifario vigente todavía no se ha guardado. */
  sinGuardar: boolean;
}

interface Fila {
  id: string;
  platformId: PlatformId;
  nombre: string;
  cantidad: number;
  entrada: EntradaTarifa | null;
  /** Lo que se ve en el campo: las views manuales, o las de la línea base confiable. */
  views: number | null;
  /** Sugerencia para el campo vacío: la mediana poco confiable. */
  viewsPlaceholder: number | null;
  viewsEtiqueta: string;
  cpmLow: string | null;
  cpmHigh: string | null;
  cpmEditado: boolean;
  benchmark: { low: string; high: string } | null;
  precioLow: string | null;
  precioHigh: string | null;
  editado: boolean;
  /** Por qué el precio escrito a mano no vale (al revés, vacío, en cero), o null. */
  errorRango: string | null;
  motivos: string[];
  pasos: string[];
}

/** Estilo de un botón fantasma pequeño del kit, para los que necesitan aria-expanded (Button no lo pasa). */
const BOTON_DISCRETO =
  "inline-flex min-h-7 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2.5 py-1 text-xs font-medium leading-4 " +
  "text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** El id del desglose de una fila o de un paquete, para aria-controls. */
const idDesglose = (id: string) => `tarifario-explicacion-${id}`;

/**
 * La tabla del tarifario: un entregable por fila, con su rango y su
 * desglose.
 *
 * Todo lo que se ve se recalcula en el navegador con `calcularItem` de
 * @mc/core, la MISMA función que el servidor usa al guardar. Por eso el
 * rango no parpadea al guardar: no hay dos fórmulas.
 *
 * El rango es TEXTO: es el número principal de la pantalla y tiene que
 * leerse entero sin entrar a un campo. Los campos (rango y CPM a mano)
 * se abren con «Editar» en la fila. Las columnas van en el orden en que
 * se leen en un teléfono: entregable (con sus botones) y rango primero,
 * lo demás después.
 *
 * «Cómo se calcula» se abre JUSTO DEBAJO de su fila (TablaConDetalle),
 * como el desglose de comisiones de Stripe, pegado al monto que explica.
 *
 * Un precio a mano que no vale (el bajo mayor que el alto, un extremo
 * vacío, el alto en cero) se marca en la fila con aria-invalid, la fila
 * no se cierra con «Listo» y el tarifario no se guarda hasta corregirlo.
 * La regla es validarRangoPrecio de @mc/core, la misma del servidor.
 *
 * Las celdas con textos sr-only llevan `relative`: un sr-only es
 * `position: absolute`, y sin un ancestro posicionado dentro de la
 * tabla escapa del scroll horizontal y ensancha la página a 400 px.
 */
export function TarifarioTabla({ creatorId, inputs, basisInicial, settings, sinGuardar }: TarifarioTablaProps) {
  const t = MESSAGES.tarifario;
  const f = useMemo(() => formatterFor(settings), [settings]);
  const [basis, setBasis] = useState<BasisTarifario>(basisInicial);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(guardarTarifario, {});
  const tituloDesglose = useRef<HTMLHeadingElement>(null);
  const moneda = inputs.currency;
  const dinero = (v: string) => f.money(v, moneda, { mode: "full" });

  const filasBase = useMemo(() => construirFilas(inputs, basis), [inputs, basis]);

  const filas: Fila[] = useMemo(() => {
    const din = (v: string) => f.money(v, moneda, { mode: "full" });
    return filasBase.map((fila) => {
      const red = PLATFORM_LABEL[fila.def.platformId];
      const motivoRango = motivoRangoManual(fila);
      const errorRango = motivoRango ? (t.rangoErrores[motivoRango] ?? null) : null;
      const comun = {
        id: fila.def.id,
        platformId: fila.def.platformId,
        nombre: nombreEntregable(fila.def.id),
        cantidad: fila.def.cantidad,
        cpmEditado: fila.cpmManual !== null,
        benchmark: fila.benchmark ? { low: fila.benchmark.cpmLow, high: fila.benchmark.cpmHigh } : null,
        cpmLow: fila.cpmManual?.low ?? fila.benchmark?.cpmLow ?? null,
        cpmHigh: fila.cpmManual?.high ?? fila.benchmark?.cpmHigh ?? null,
        viewsPlaceholder: fila.baseline && !fila.baseline.isReliable ? fila.baseline.medianViews : null,
        errorRango,
      };
      if (!fila.entrada) {
        const manual = basis.viewsManuales[fila.def.id];
        // A una fila que solo le falta el CPM no se le piden las views:
        // si la línea base es confiable, el campo las enseña como en las
        // demás filas, y lo único que queda a la vista es lo que falta.
        const deBaseline = manual === undefined && fila.baseline?.isReliable ? fila.baseline.medianViews : null;
        const motivos = fila.motivos.map((m) => textoMotivo(m, fila, inputs.country, red, f));
        // Un precio a mano que no vale también se dice aquí: si la fila
        // perdió sus views, es el único sitio donde se ve.
        if (errorRango) motivos.push(errorRango);
        return {
          ...comun,
          entrada: null,
          views: manual ?? deBaseline,
          viewsEtiqueta:
            manual !== undefined
              ? t.viewsManuales
              : deBaseline !== null
                ? t.viewsBaseline
                : comun.viewsPlaceholder !== null
                  ? t.viewsPocoFiables
                  : t.viewsManuales,
          precioLow: null,
          precioHigh: null,
          editado: false,
          motivos,
          pasos: [],
        };
      }
      const item = calcularItem(fila.entrada);
      const precio = precioDe(item, fila.precioManual);
      const pasos = explicarPasos(item.pasos, moneda, f);
      if (precio.editado && !errorRango) pasos.push(MESSAGES.explicacion.editado(din(precio.low), din(precio.high)));
      return {
        ...comun,
        entrada: fila.entrada,
        views: fila.entrada.views,
        viewsEtiqueta: fila.entrada.viewsSource === "manual" ? t.viewsManuales : t.viewsBaseline,
        precioLow: precio.low,
        precioHigh: precio.high,
        editado: precio.editado,
        motivos: [],
        pasos,
      };
    });
  }, [filasBase, basis.viewsManuales, f, moneda, inputs.country, t]);

  const paquetes = useMemo(() => construirPaquetes(filasBase, basis, moneda, f), [filasBase, basis, moneda, f]);
  const conPrecio = filas.filter((r) => r.precioLow !== null && !r.errorRango);
  // La acción de guardar aplica la MISMA regla (validarRangoPrecio) y
  // devuelve su propio aviso; aquí basta con la de la pantalla.
  const hayInvalidos = filas.some((r) => r.errorRango !== null);

  // Al abrir un desglose, el foco va a su título: con teclado o lector
  // de pantalla se sabe que algo se abrió, y dónde (justo debajo).
  useEffect(() => {
    if (abierta) tituloDesglose.current?.focus();
  }, [abierta]);

  function cambiarViews(id: string, valor: string) {
    const limpio = valor.replace(/\D/g, "");
    setBasis((b) => {
      const viewsManuales = { ...b.viewsManuales };
      if (!limpio) delete viewsManuales[id];
      else viewsManuales[id] = Number(limpio);
      return { ...b, viewsManuales };
    });
  }

  /**
   * Un extremo del precio a mano. El primero que se toca arranca desde
   * el rango de la fórmula; un campo borrado se queda VACÍO (y la fila
   * lo marca como inválido), no se convierte en «0».
   */
  function cambiarPrecio(id: string, campo: "low" | "high", valor: string) {
    setBasis((b) => {
      const fila = filas.find((x) => x.id === id);
      const actual = b.precios[id] ?? { low: fila?.precioLow ?? "", high: fila?.precioHigh ?? "" };
      return { ...b, precios: { ...b.precios, [id]: { ...actual, [campo]: valor } } };
    });
  }

  function cambiarCpm(id: string, campo: "low" | "high", valor: string) {
    setBasis((b) => {
      const fila = filas.find((x) => x.id === id);
      const actual = b.cpm[id] ?? { low: fila?.cpmLow ?? "", high: fila?.cpmHigh ?? "" };
      return { ...b, cpm: { ...b.cpm, [id]: { ...actual, [campo]: valor } } };
    });
  }

  function quitarEdicion(id: string) {
    setBasis((b) => {
      const precios = { ...b.precios };
      const cpm = { ...b.cpm };
      delete precios[id];
      delete cpm[id];
      return { ...b, precios, cpm };
    });
    if (editando === id) setEditando(null);
  }

  function alternarModificador(id: string) {
    setBasis((b) => ({
      ...b,
      modificadores: b.modificadores.includes(id) ? b.modificadores.filter((x) => x !== id) : [...b.modificadores, id],
    }));
  }

  const siguientePaquete = useRef(basisInicial.paquetes.length);
  function agregarPaquete() {
    const id = `p${++siguientePaquete.current}`;
    const componentes = Object.fromEntries(conPrecio.slice(0, 2).map((r) => [r.id, 1]));
    setBasis((b) => ({ ...b, paquetes: [...b.paquetes, { id, componentes, descuentoPct: "0.1" }] }));
  }

  function cambiarPaquete(id: string, cambio: (p: BasisTarifario["paquetes"][number]) => BasisTarifario["paquetes"][number]) {
    setBasis((b) => ({ ...b, paquetes: b.paquetes.map((p) => (p.id === id ? cambio(p) : p)) }));
  }

  /** El botón que abre o cierra el desglose de una fila o de un paquete. */
  function botonDesglose(id: string, nombre: string) {
    const abiertoAqui = abierta === id;
    return (
      <button
        type="button"
        className={BOTON_DISCRETO}
        aria-expanded={abiertoAqui}
        aria-controls={abiertoAqui ? idDesglose(id) : undefined}
        onClick={() => setAbierta(abiertoAqui ? null : id)}
      >
        {abiertoAqui ? t.cerrar : t.comoSeCalcula}
        <span className="sr-only"> · {nombre}</span>
      </button>
    );
  }

  /**
   * Las acciones de una fila van en la PRIMERA columna, bajo el nombre:
   * a 400 px la tabla hace scroll horizontal y una columna de acciones
   * al final quedaba en x≈614, fuera de la pantalla, justo con la
   * función estrella del módulo («Cómo se calcula»). Así, el botón, el
   * nombre y el rango que explica se ven juntos sin desplazar nada.
   */
  function accionesFila(r: Fila) {
    const conRango = r.precioLow !== null;
    const recalcular = r.editado || r.cpmEditado;
    if (!conRango && !recalcular) return null;
    return (
      <span className="relative -ml-2.5 flex flex-wrap gap-x-1 gap-y-0.5" data-acciones-fila={r.id}>
        {conRango && botonDesglose(r.id, r.nombre)}
        {conRango && (
          <button
            type="button"
            className={BOTON_DISCRETO}
            // «Listo» no cierra un rango que no vale: primero se corrige.
            disabled={editando === r.id && r.errorRango !== null}
            aria-describedby={editando === r.id && r.errorRango ? `rango-error-${r.id}` : undefined}
            onClick={() => setEditando(editando === r.id ? null : r.id)}
          >
            {editando === r.id ? t.listo : t.editar}
            <span className="sr-only"> · {r.nombre}</span>
          </button>
        )}
        {recalcular && (
          <button type="button" className={BOTON_DISCRETO} onClick={() => quitarEdicion(r.id)}>
            {t.recalcular}
            <span className="sr-only"> · {r.nombre}</span>
          </button>
        )}
      </span>
    );
  }

  const columnas: ColumnaConDetalle<Fila>[] = [
    {
      key: "entregable",
      header: t.columnas.entregable,
      render: (r) => (
        <span className="flex min-w-[8.5rem] flex-col items-start gap-1">
          <CellMain sub={r.cantidad > 1 ? t.piezas(f.int(r.cantidad)) : undefined}>{r.nombre}</CellMain>
          <PlatformPill platformId={r.platformId} />
          {accionesFila(r)}
        </span>
      ),
    },
    {
      key: "rango",
      header: t.columnas.rango,
      render: (r) => {
        if (r.precioLow === null || r.precioHigh === null) {
          return (
            <span className="block max-w-[15rem] text-xs leading-4 text-ink-2">
              {r.motivos.map((m) => (
                <span key={m} className="block">
                  {m}
                </span>
              ))}
            </span>
          );
        }
        // Un rango que no vale se queda abierto aunque se edite otra fila.
        if (editando === r.id || r.errorRango) {
          return <RangoEditable fila={r} moneda={moneda} error={r.errorRango} onChange={cambiarPrecio} />;
        }
        return (
          <span className="flex flex-col items-start gap-1">
            <span className="font-mono text-sm font-medium tabular-nums text-ink lg:whitespace-nowrap" data-testid={`rango-${r.id}`}>
              <span className="whitespace-nowrap">{dinero(r.precioLow)}</span>{" "}
              <span className="whitespace-nowrap">– {dinero(r.precioHigh)}</span>
            </span>
            {r.editado ? <Pill kind="warn">{t.editado}</Pill> : <Pill kind="neutral">{t.sugerido}</Pill>}
          </span>
        );
      },
    },
    {
      key: "views",
      header: t.columnas.views,
      align: "num",
      render: (r) => (
        <span className="flex flex-col items-end gap-1">
          <ViewsInput
            label={`${t.columnas.views} · ${r.nombre}`}
            value={r.views}
            placeholder={r.viewsPlaceholder}
            f={f}
            onChange={(v) => cambiarViews(r.id, v)}
          />
          <span className="font-sans text-xs text-muted">{r.viewsEtiqueta}</span>
        </span>
      ),
    },
    {
      key: "cpm",
      header: t.columnas.cpm,
      align: "num",
      render: (r) => {
        const sinCpm = r.cpmLow === null || r.cpmHigh === null;
        if (editando === r.id || sinCpm) {
          return (
            <span className="relative flex flex-col items-end gap-1.5 font-sans">
              <label className="contents">
                <span className="sr-only">{`${t.cpmBajo} · ${r.nombre}`}</span>
                <MoneyInput value={r.cpmLow ?? ""} currency={moneda} onChange={(v) => cambiarCpm(r.id, "low", v)} className="w-36 min-w-[8rem]" />
              </label>
              <label className="contents">
                <span className="sr-only">{`${t.cpmAlto} · ${r.nombre}`}</span>
                <MoneyInput value={r.cpmHigh ?? ""} currency={moneda} onChange={(v) => cambiarCpm(r.id, "high", v)} className="w-36 min-w-[8rem]" />
              </label>
              {r.benchmark && r.cpmEditado && (
                <span className="text-xs text-muted">{t.cpmReferencia(dinero(r.benchmark.low), dinero(r.benchmark.high))}</span>
              )}
            </span>
          );
        }
        return (
          <span className="flex flex-col items-end gap-1">
            <span>
              {dinero(r.cpmLow!)} – {dinero(r.cpmHigh!)}
            </span>
            {r.cpmEditado && <Pill kind="warn">{t.cpmPropio}</Pill>}
          </span>
        );
      },
    },
  ];

  return (
    <form action={formAction} className="min-w-0 space-y-6">
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="estado" value={JSON.stringify(basis)} />

      {state.message && (
        <p role="alert" className="rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {state.message}
        </p>
      )}
      {sinGuardar && !state.ok && (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <strong className="font-medium text-ink">{MESSAGES.tarifario.sinTarifario.title}</strong>{" "}
          {MESSAGES.tarifario.sinTarifario.description}
        </p>
      )}

      <section aria-labelledby="modificadores" className="min-w-0 rounded-md border border-border p-4">
        <h2 id="modificadores" className="text-sm font-semibold">
          {t.modificadores.title}
        </h2>
        <p className="mt-1 text-xs leading-4 text-muted">{t.modificadores.description}</p>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {MODIFICADORES_POR_DEFECTO.map((m) => (
            <li key={m.id} className="min-w-0">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  checked={basis.modificadores.includes(m.id)}
                  onChange={() => alternarModificador(m.id)}
                />
                <span className="min-w-0">
                  {nombreModificador(m.id)}{" "}
                  <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted">+{f.pct(Number(m.pct))}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <TablaConDetalle
        columns={columnas}
        rows={filas}
        rowKey={(r) => r.id}
        caption={t.tabla}
        detalleId={(r) => idDesglose(r.id)}
        detalle={(r) =>
          abierta === r.id && r.pasos.length > 0 ? (
            <Desglose id={r.id} nombre={r.nombre} pasos={r.pasos} tituloRef={tituloDesglose} />
          ) : null
        }
        emptyState={
          <EmptyState
            title={t.vacio.title}
            description={t.vacio.description}
            action={{ label: t.vacio.accion, href: "/conexiones" }}
          />
        }
      />

      <section aria-labelledby="paquetes" className="min-w-0 rounded-md border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-xl">
            <h2 id="paquetes" className="text-sm font-semibold">
              {MESSAGES.paquetes.title}
            </h2>
            <p className="mt-1 text-xs leading-4 text-muted">{MESSAGES.paquetes.description}</p>
          </div>
          <Button size="sm" onClick={agregarPaquete} disabled={conPrecio.length === 0}>
            {MESSAGES.paquetes.agregar}
          </Button>
        </div>
        {conPrecio.length === 0 && <p className="mt-3 text-xs text-muted">{MESSAGES.paquetes.sinPrecios}</p>}
        <ul className="mt-4 space-y-4">
          {paquetes.map((p) => (
            <li key={p.basis.id} className="min-w-0 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.nombre}</p>
                  {p.item ? (
                    <p className="mt-1 font-mono text-sm tabular-nums" data-testid={`rango-${p.basis.id}`}>
                      <span className="whitespace-nowrap">{dinero(p.item.priceLow)}</span>{" "}
                      <span className="whitespace-nowrap">– {dinero(p.item.priceHigh)}</span>
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted">{MESSAGES.paquetes.vacio}</p>
                  )}
                </div>
                <span className="flex flex-wrap gap-1">
                  {p.item && botonDesglose(p.basis.id, p.nombre)}
                  <button
                    type="button"
                    className={BOTON_DISCRETO}
                    onClick={() => setBasis((b) => ({ ...b, paquetes: b.paquetes.filter((x) => x.id !== p.basis.id) }))}
                  >
                    {MESSAGES.paquetes.quitar}
                  </button>
                </span>
              </div>
              {abierta === p.basis.id && p.item && (
                <div id={idDesglose(p.basis.id)} className="mt-3 rounded-md border border-border bg-surface-2 p-3">
                  <Desglose
                    id={p.basis.id}
                    nombre={p.nombre}
                    pasos={explicarPasos(p.item.pasos, moneda, f)}
                    tituloRef={tituloDesglose}
                  />
                </div>
              )}
              <fieldset className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <legend className="sr-only">{MESSAGES.paquetes.incluye}</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {ENTREGABLES.filter((d) => conPrecio.some((r) => r.id === d.id)).map((d) => {
                    const cantidad = p.basis.componentes[d.id] ?? 0;
                    return (
                      <li key={d.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                          aria-label={nombreEntregable(d.id)}
                          checked={cantidad > 0}
                          onChange={() =>
                            cambiarPaquete(p.basis.id, (x) => {
                              const componentes = { ...x.componentes };
                              if (cantidad > 0) delete componentes[d.id];
                              else componentes[d.id] = 1;
                              return { ...x, componentes };
                            })
                          }
                        />
                        <Input
                          aria-label={MESSAGES.paquetes.cantidad(nombreEntregable(d.id))}
                          inputMode="numeric"
                          className="w-14 text-right font-mono tabular-nums"
                          value={cantidad > 0 ? String(cantidad) : ""}
                          placeholder="0"
                          onChange={(e) =>
                            cambiarPaquete(p.basis.id, (x) => {
                              const n = Number(e.target.value.replace(/\D/g, "").slice(0, 2));
                              const componentes = { ...x.componentes };
                              if (!n) delete componentes[d.id];
                              else componentes[d.id] = n;
                              return { ...x, componentes };
                            })
                          }
                        />
                        <span className="min-w-0 truncate">{nombreEntregable(d.id)}</span>
                      </li>
                    );
                  })}
                </ul>
                <DescuentoPaquete
                  id={p.basis.id}
                  fraccion={p.basis.descuentoPct}
                  onChange={(fraccion) => cambiarPaquete(p.basis.id, (x) => ({ ...x, descuentoPct: fraccion }))}
                />
              </fieldset>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={pending} disabled={hayInvalidos}>
          {t.guardar}
        </Button>
        {hayInvalidos && <span className="text-sm text-bad">{t.rangoRevisar}</span>}
        {state.ok && !hayInvalidos && (
          <span role="status" className="text-sm text-good">
            {t.guardado}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * El «Cómo se calcula» de una fila o de un paquete: una lista numerada
 * de pasos, cada uno con su cifra ya formateada. El título recibe el
 * foco al abrirse.
 */
function Desglose({
  id, nombre, pasos, tituloRef,
}: {
  id: string;
  nombre: string;
  pasos: readonly string[];
  tituloRef: RefObject<HTMLHeadingElement | null>;
}) {
  const tituloId = `${idDesglose(id)}-titulo`;
  return (
    <section aria-labelledby={tituloId} className="min-w-0">
      <h3 id={tituloId} ref={tituloRef} tabIndex={-1} className="pt-2 text-sm font-semibold focus:outline-none">
        {MESSAGES.tarifario.desgloseDe(nombre)}
      </h3>
      <ol className="mt-2 space-y-1.5 text-sm text-ink-2">
        {pasos.map((paso, i) => (
          <li key={i} className="flex gap-2 border-b border-border pb-1.5 last:border-b-0 last:pb-0">
            <span aria-hidden="true" className="font-mono text-xs text-muted">
              {i + 1}
            </span>
            <span className="min-w-0 whitespace-normal tabular-nums">{paso}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Los dos extremos del precio escrito a mano, con su error debajo cuando
 * no vale. aria-invalid va en los dos campos, y el error es la
 * descripción del grupo que los contiene (el lector lo dice al entrar) y
 * además se anuncia al aparecer (role="alert").
 */
function RangoEditable({
  fila, moneda, error, onChange,
}: {
  fila: Fila;
  moneda: string;
  error: string | null;
  onChange: (id: string, campo: "low" | "high", valor: string) => void;
}) {
  const t = MESSAGES.tarifario;
  const errorId = `rango-error-${fila.id}`;
  return (
    <span
      className="relative flex flex-col gap-1.5"
      role="group"
      aria-label={`${t.columnas.rango} · ${fila.nombre}`}
      aria-describedby={error ? errorId : undefined}
    >
      <label className="contents">
        <span className="sr-only">{`${t.columnas.rango} ${t.rangoBajo} · ${fila.nombre}`}</span>
        <MoneyInput
          value={fila.precioLow ?? ""}
          currency={moneda}
          invalid={Boolean(error)}
          onChange={(v) => onChange(fila.id, "low", v)}
          className="w-44 min-w-[9rem]"
        />
      </label>
      <label className="contents">
        <span className="sr-only">{`${t.columnas.rango} ${t.rangoAlto} · ${fila.nombre}`}</span>
        <MoneyInput
          value={fila.precioHigh ?? ""}
          currency={moneda}
          invalid={Boolean(error)}
          onChange={(v) => onChange(fila.id, "high", v)}
          className="w-44 min-w-[9rem]"
        />
      </label>
      {error && (
        <span id={errorId} role="alert" className="block max-w-[11rem] whitespace-normal text-xs leading-4 text-bad">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Las views por pieza. Mientras se escribe, cifras sueltas («115446»);
 * fuera del campo, con el separador de miles del workspace («115.446»),
 * como todas las demás cifras de la pantalla.
 */
function ViewsInput({
  label, value, placeholder, f, onChange,
}: {
  label: string;
  value: number | null;
  placeholder: number | null;
  f: Formatter;
  onChange: (valor: string) => void;
}) {
  const [enfocado, setEnfocado] = useState(false);
  const mostrado = value === null ? "" : enfocado ? String(value) : f.int(value);
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      autoComplete="off"
      className="w-28 text-right font-mono tabular-nums"
      value={mostrado}
      placeholder={placeholder !== null ? f.int(placeholder) : "0"}
      onFocus={() => setEnfocado(true)}
      onBlur={() => setEnfocado(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * El descuento de un paquete: se escribe como porcentaje («12») y se
 * guarda como fracción ('0.12'), con las mismas funciones de @mc/core
 * que usa el IVA de Finanzas. El texto crudo vive aquí para poder
 * borrarlo y escribir otro sin que salte a «0».
 */
function DescuentoPaquete({ id, fraccion, onChange }: { id: string; fraccion: string; onChange: (fraccion: string) => void }) {
  const [texto, setTexto] = useState(() => rateToPct(fraccion || "0"));
  const [error, setError] = useState<string | undefined>();
  return (
    <Field label={MESSAGES.paquetes.descuento} error={error} htmlFor={`descuento-${id}`}>
      <Input
        inputMode="decimal"
        className="text-right font-mono tabular-nums"
        value={texto}
        onChange={(e) => {
          const valor = e.target.value;
          setTexto(valor);
          try {
            const r = pctToRate(valor || "0");
            if (Number(r) > 1) throw new Error("fuera de rango");
            setError(undefined);
            onChange(r);
          } catch {
            setError(MESSAGES.paquetes.descuentoError);
          }
        }}
      />
    </Field>
  );
}
