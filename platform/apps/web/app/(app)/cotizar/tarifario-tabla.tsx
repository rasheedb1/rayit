"use client";

import { useActionState, useMemo, useState } from "react";
import { calcularItem, MODIFICADORES_POR_DEFECTO, type EntradaTarifa } from "@mc/core";
import type { RateCardInputs } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type FormatSettings } from "@/lib/format";
import type { ActionState } from "@/lib/forms";
import { guardarTarifario } from "./actions";
import { MESSAGES, nombreEntregable, nombreModificador } from "./messages";
import { construirFilas, explicarPasos, precioDe, type BasisTarifario } from "./_lib/tarifario";

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
  platformId: "tiktok" | "instagram" | "facebook" | "youtube";
  nombre: string;
  cantidad: number;
  entrada: EntradaTarifa | null;
  views: number | null;
  viewsManuales: boolean;
  cpmLow: string | null;
  cpmHigh: string | null;
  precioLow: string | null;
  precioHigh: string | null;
  editado: boolean;
  pasos: string[];
}

/**
 * La tabla del tarifario: un entregable por fila, con su rango y su
 * desglose.
 *
 * Todo lo que se ve se recalcula en el navegador con `calcularItem` de
 * @mc/core, la MISMA función que el servidor usa al guardar. Por eso el
 * rango no parpadea al guardar: no hay dos fórmulas.
 */
export function TarifarioTabla({ creatorId, inputs, basisInicial, settings, sinGuardar }: TarifarioTablaProps) {
  const t = MESSAGES.tarifario;
  const f = useMemo(() => formatterFor(settings), [settings]);
  const [basis, setBasis] = useState<BasisTarifario>(basisInicial);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(guardarTarifario, {});

  const filas: Fila[] = useMemo(
    () =>
      construirFilas(inputs, basis).map((fila) => {
        if (!fila.entrada) {
          return {
            id: fila.def.id,
            platformId: fila.def.platformId,
            nombre: nombreEntregable(fila.def.id),
            cantidad: fila.def.cantidad,
            entrada: null,
            views: basis.viewsManuales[fila.def.id] ?? null,
            viewsManuales: true,
            cpmLow: null,
            cpmHigh: null,
            precioLow: null,
            precioHigh: null,
            editado: false,
            pasos: [],
          };
        }
        const item = calcularItem(fila.entrada);
        const precio = precioDe(item, fila.precioManual);
        const pasos = explicarPasos(item.pasos, inputs.currency, f);
        if (precio.editado) pasos.push(MESSAGES.explicacion.editado(
          f.money(precio.low, inputs.currency, { mode: "full" }),
          f.money(precio.high, inputs.currency, { mode: "full" }),
        ));
        return {
          id: fila.def.id,
          platformId: fila.def.platformId,
          nombre: nombreEntregable(fila.def.id),
          cantidad: fila.def.cantidad,
          entrada: fila.entrada,
          views: fila.entrada.views,
          viewsManuales: fila.entrada.viewsSource === "manual",
          cpmLow: fila.entrada.cpmLow,
          cpmHigh: fila.entrada.cpmHigh,
          precioLow: precio.low,
          precioHigh: precio.high,
          editado: precio.editado,
          pasos,
        };
      }),
    [inputs, basis, f],
  );

  function cambiarViews(id: string, valor: string) {
    const n = Number(valor.replace(/\D/g, ""));
    setBasis((b) => {
      const viewsManuales = { ...b.viewsManuales };
      if (!valor.trim() || !Number.isFinite(n)) delete viewsManuales[id];
      else viewsManuales[id] = n;
      return { ...b, viewsManuales };
    });
  }

  function cambiarPrecio(id: string, campo: "low" | "high", valor: string) {
    setBasis((b) => {
      const actual = b.precios[id] ?? { low: "", high: "" };
      const fila = filas.find((x) => x.id === id);
      const base = { low: actual.low || fila?.precioLow || "0", high: actual.high || fila?.precioHigh || "0" };
      return { ...b, precios: { ...b.precios, [id]: { ...base, [campo]: valor || "0" } } };
    });
  }

  function quitarEdicion(id: string) {
    setBasis((b) => {
      const precios = { ...b.precios };
      delete precios[id];
      return { ...b, precios };
    });
  }

  function alternarModificador(id: string) {
    setBasis((b) => ({
      ...b,
      modificadores: b.modificadores.includes(id) ? b.modificadores.filter((x) => x !== id) : [...b.modificadores, id],
    }));
  }

  const columnas: Column<Fila>[] = [
    {
      key: "entregable",
      header: t.columnas.entregable,
      render: (r) => (
        <span className="flex flex-col gap-1">
          <CellMain sub={r.cantidad > 1 ? `${f.int(r.cantidad)} piezas` : undefined}>{r.nombre}</CellMain>
          <PlatformPill platformId={r.platformId} />
        </span>
      ),
    },
    {
      key: "views",
      header: t.columnas.views,
      align: "num",
      width: "11rem",
      render: (r) => (
        <span className="flex flex-col items-end gap-1">
          <Input
            aria-label={`${t.columnas.views} · ${r.nombre}`}
            inputMode="numeric"
            className="w-28 text-right font-mono tabular-nums"
            value={r.views === null ? "" : String(r.views)}
            placeholder="0"
            onChange={(e) => cambiarViews(r.id, e.target.value)}
          />
          <span className="text-xs text-muted">{r.viewsManuales ? t.viewsManuales : t.viewsBaseline}</span>
        </span>
      ),
    },
    {
      key: "cpm",
      header: t.columnas.cpm,
      align: "num",
      render: (r) =>
        r.cpmLow && r.cpmHigh ? (
          <span className="whitespace-nowrap">
            {f.money(r.cpmLow, inputs.currency)} – {f.money(r.cpmHigh, inputs.currency)}
          </span>
        ) : (
          <span className="font-sans text-muted">—</span>
        ),
    },
    {
      key: "rango",
      header: t.columnas.rango,
      align: "num",
      width: "15rem",
      render: (r) =>
        r.precioLow && r.precioHigh ? (
          <span className="flex flex-col items-end gap-1">
            <span className="flex items-center gap-1.5">
              {/* El <label> envuelve al control: MoneyInput no recibe id desde
                  fuera de un Field, y en una tabla la etiqueta no se ve pero
                  el lector de pantalla necesita saber qué fila es. */}
              <label className="contents">
                <span className="sr-only">{`${t.columnas.rango} bajo · ${r.nombre}`}</span>
                <MoneyInput
                  value={r.precioLow}
                  currency={inputs.currency}
                  onChange={(v) => cambiarPrecio(r.id, "low", v)}
                  className="w-28"
                />
              </label>
              <span aria-hidden="true" className="text-muted">
                –
              </span>
              <label className="contents">
                <span className="sr-only">{`${t.columnas.rango} alto · ${r.nombre}`}</span>
                <MoneyInput
                  value={r.precioHigh}
                  currency={inputs.currency}
                  onChange={(v) => cambiarPrecio(r.id, "high", v)}
                  className="w-28"
                />
              </label>
            </span>
            <span className="flex items-center gap-2">
              {r.editado ? <Pill kind="warn">{t.editado}</Pill> : <Pill kind="neutral">{t.sugerido}</Pill>}
              {r.editado && (
                <Button size="sm" variant="ghost" onClick={() => quitarEdicion(r.id)}>
                  {t.recalcular}
                </Button>
              )}
            </span>
          </span>
        ) : (
          <span className="font-sans text-muted">—</span>
        ),
    },
    {
      key: "explicacion",
      header: t.comoSeCalcula,
      render: (r) =>
        r.pasos.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAbierta(abierta === r.id ? null : r.id)}>
            {abierta === r.id ? t.cerrar : t.comoSeCalcula}
          </Button>
        ),
    },
  ];

  const abiertaFila = filas.find((r) => r.id === abierta);

  return (
    <form action={formAction} className="space-y-6">
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

      <section aria-labelledby="modificadores" className="rounded-md border border-border p-4">
        <h2 id="modificadores" className="text-sm font-semibold">
          {t.modificadores.title}
        </h2>
        <p className="mt-1 text-xs leading-4 text-muted">{t.modificadores.description}</p>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {MODIFICADORES_POR_DEFECTO.map((m) => (
            <li key={m.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={basis.modificadores.includes(m.id)}
                  onChange={() => alternarModificador(m.id)}
                />
                <span>{nombreModificador(m.id)}</span>
                <span className="font-mono text-xs tabular-nums text-muted">+{f.pct(Number(m.pct))}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <DataTable
        columns={columnas}
        rows={filas}
        rowKey={(r) => r.id}
        caption={t.tabla}
        emptyState={
          <EmptyState
            title={t.vacio.title}
            description={t.vacio.description}
            action={{ label: t.vacio.accion, href: "/conexiones" }}
          />
        }
      />

      {abiertaFila && (
        <section aria-live="polite" aria-labelledby="explicacion" className="rounded-md border border-border bg-surface-2 p-4">
          <h2 id="explicacion" className="text-sm font-semibold">
            {t.comoSeCalcula} · {abiertaFila.nombre}
          </h2>
          <ol className="mt-3 space-y-1.5 text-sm text-ink-2">
            {abiertaFila.pasos.map((paso, i) => (
              <li key={i} className="flex gap-2 border-b border-border pb-1.5 last:border-b-0 last:pb-0">
                <span aria-hidden="true" className="font-mono text-xs text-muted">
                  {i + 1}
                </span>
                <span className="tabular-nums">{paso}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={pending}>
          {t.guardar}
        </Button>
        {state.ok && <span className="text-sm text-good">Guardado</span>}
      </div>
    </form>
  );
}
