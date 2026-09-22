"use client";

import { useState } from "react";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";

type Cxc = { id: string; brand: string; campaign: string; amount: string; due: string; days: number; status: [string, PillKind] };

/** La tabla CXC del mock de Finanzas. */
export const CXC: Cxc[] = [
  { id: "f-118", brand: "Fresko Market", campaign: "Lanzamiento línea vegana", amount: "5200000.00", due: "2 oct", days: 12, status: ["Enviada", "neutral"] },
  { id: "f-114", brand: "Café Alma", campaign: "Campaña 24–31 ago", amount: "3100000.00", due: "25 sep", days: 5, status: ["Vence pronto", "warn"] },
  { id: "f-109", brand: "Distribuidora Nacional de Alimentos S.A.S.", campaign: "Reel de recetas", amount: "1100000.00", due: "11 ago", days: -41, status: ["Vencida · 41 días", "bad"] },
  { id: "f-121", brand: "Hotel Casa Verde", campaign: "Serie de fin de semana", amount: "1234567890.50", due: "30 oct", days: 40, status: ["Pagada", "good"] },
];

const columns: Column<Cxc>[] = [
  { key: "brand", header: "Marca", render: (r) => <CellMain sub={r.campaign}>{r.brand}</CellMain> },
  { key: "amount", header: "Monto", align: "num", render: (r) => formatMoney(r.amount, "COP", { mode: "full" }) },
  { key: "due", header: "Vence", width: "6rem" },
  { key: "status", header: "Estado", render: (r) => <Pill kind={r.status[1]}>{r.status[0]}</Pill> },
  {
    key: "action",
    header: "Acción",
    render: (r) => (
      <Button size="sm" onClick={(e) => e.stopPropagation()}>
        {r.days < 0 ? "Enviar recordatorio" : "Adelantar"}
      </Button>
    ),
  },
];

export function TableDemo() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <DataTable columns={columns} rows={CXC} rowKey={(r) => r.id} caption="Cuentas por cobrar" emptyState={<EmptyState title="Nada por cobrar" />} onRowClick={(r) => setPicked(r.brand)} />
      <p className="text-xs text-muted">Fila elegida: {picked ?? "ninguna (haz clic o pulsa Enter sobre una fila)"}</p>
    </div>
  );
}
