"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { MESSAGES } from "../_lib/messages";
import { GastoForm } from "./form";
import type { GastoVista } from "./_lib/vista";

const T = MESSAGES.gastos;

/**
 * Las columnas se construyen aquí con textos ya formateados por el
 * servidor (`gastoVista`): el formateador del espacio no cruza la
 * frontera servidor → cliente, y esta tabla vive en un componente de
 * cliente porque «Editar» abre el formulario en la misma pantalla.
 */
function columnas(onEditar: (g: GastoVista) => void): Column<GastoVista>[] {
  const t = T.tabla;
  return [
    {
      key: "concepto",
      header: t.columnas.concepto,
      render: (g) => (
        <CellMain sub={g.sinProveedor ? undefined : g.proveedor}>
          <span className={g.conceptoEsRelleno ? "text-muted" : ""}>{g.concepto}</span>
        </CellMain>
      ),
    },
    { key: "categoria", header: t.columnas.categoria, render: (g) => g.categoria },
    { key: "fecha", header: t.columnas.fecha, render: (g) => <span className="whitespace-nowrap">{g.fecha}</span> },
    { key: "monto", header: t.columnas.monto, align: "num", render: (g) => g.monto },
    {
      key: "marcas",
      header: t.columnas.marcas,
      render: (g) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill kind={g.recurrente ? "warn" : "neutral"}>{g.recurrente ? (g.recurrencia ?? t.recurrente) : t.puntual}</Pill>
          {g.deducible ? <Pill kind="good">{t.deducible}</Pill> : <Pill kind="neutral">{t.noDeducible}</Pill>}
          {/* noreferrer noopener: el enlace es de un tercero (Drive, el correo del proveedor). */}
          {g.receiptUrl ? (
            <a
              href={g.receiptUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-ink underline underline-offset-4 hover:text-ink-2"
            >
              {t.recibo}
            </a>
          ) : (
            <span className="text-xs text-muted">{t.sinRecibo}</span>
          )}
        </span>
      ),
    },
    {
      key: "accion",
      header: t.columnas.accion,
      render: (g) => (
        <Button size="sm" onClick={() => onEditar(g)}>
          {t.editar}
        </Button>
      ),
    },
  ];
}

export interface GastosPanelProps {
  gastos: GastoVista[];
  currency: string;
  /** Hoy según la base: la fecha por defecto del formulario. */
  hoy: string;
  /** Cuántos gastos del mes están en otra moneda y no entran en los totales. */
  otraMoneda: number;
  /** Si el mes que se mira no es el de hoy, el vacío lo dice. */
  esMesActual: boolean;
}

/**
 * La lista del mes y el formulario, en una sola pantalla: «Nuevo gasto»
 * abre el panel arriba de la tabla y «Editar» lo abre con el gasto
 * cargado. Al guardar, la acción ya revalidó la ruta, así que solo hay
 * que cerrar el panel y decir qué pasó.
 */
export function GastosPanel({ gastos, currency, hoy, otraMoneda, esMesActual }: GastosPanelProps) {
  const [editando, setEditando] = useState<GastoVista | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  function abrirNuevo() {
    setEditando(null);
    setAbierto(true);
    setAviso(null);
  }

  function abrirEdicion(g: GastoVista) {
    setEditando(g);
    setAbierto(true);
    setAviso(null);
  }

  function cerrar() {
    setAbierto(false);
    setEditando(null);
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {gastos.length === 1 ? "1 gasto" : `${gastos.length} gastos`}
          {otraMoneda > 0 && <> · {T.tabla.otraMoneda(otraMoneda)}</>}
        </p>
        {!abierto && (
          <Button variant="primary" size="sm" onClick={abrirNuevo}>
            {T.header.nuevo}
          </Button>
        )}
      </div>

      {aviso && (
        <p role="status" className="mb-3 rounded-md border border-good/30 bg-good-wash px-3 py-2 text-sm text-ink">
          {aviso}
        </p>
      )}

      {abierto && (
        <div className="mb-4">
          {/* La key ata el estado del formulario al gasto que edita: sin
              ella, pulsar «Editar» en otra fila cambiaba el gastoId oculto
              y dejaba los campos de la fila anterior, así que guardar
              sobrescribía un gasto con los datos de otro. */}
          <GastoForm
            key={editando?.id ?? "nuevo"}
            currency={currency}
            hoy={hoy}
            gasto={editando ? { id: editando.id, crudo: editando.crudo } : undefined}
            onCancel={cerrar}
            onSaved={(frase) => {
              cerrar();
              setAviso(frase);
            }}
          />
        </div>
      )}

      <DataTable
        columns={columnas(abrirEdicion)}
        rows={gastos}
        rowKey={(g) => g.id}
        caption={T.tabla.caption}
        emptyState={
          <EmptyState
            title={T.vacio.titulo}
            description={esMesActual ? T.vacio.descripcion : T.vacio.otroMes}
            action={abierto ? undefined : { label: T.vacio.accion, onClick: abrirNuevo }}
          />
        }
      />
    </>
  );
}
