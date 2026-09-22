import type { Metadata } from "next";
import { requireModule } from "@/content/modules";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Pill } from "@/components/ui/pill";
import { EmptyState } from "@/components/ui/empty-state";
import { DataAsOf } from "@/components/ui/data-as-of";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { CellMain, DataTable } from "@/components/ui/data-table";
import { TableDemo } from "./table-demo";
import { FormDemo } from "./form-demo";
import { Section, Variant } from "./section";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = { title: "Kit de interfaz" };

const SECTIONS = [
  ["button", "Button"],
  ["pill", "Pill"],
  ["form", "Formulario"],
  ["empty-state", "EmptyState"],
  ["data-as-of", "DataAsOf"],
  ["kpi", "Kpi / KpiRow"],
  ["data-table", "DataTable"],
] as const;

// Galería del kit (CIM-5). Detrás de la bandera "kit": encendida en
// desarrollo, apagada en producción, donde esta ruta responde 404.
// El tema se cambia con el botón del shell; cada variante debe verse
// bien en claro y oscuro, a 390 px y a 1440 px.
export default function Page() {
  const mod = requireModule("kit");
  return (
    <>
      <PageHeader
        eyebrow="Construcción"
        title={mod.name}
        description="Cada componente con datos de ejemplo. Solo props, sin datos: el kit no consulta nada. Agregar un componente es libre; cambiar uno existente pide PR revisado por Nicolás."
      />
      <nav aria-label="Componentes" className="mb-10 flex flex-wrap gap-1.5">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-ink-2 hover:border-axis hover:text-ink">
            {name}
          </a>
        ))}
      </nav>

      <Section id="button" title="Button" usage={`<Button variant="primary" loading={saving} type="submit">Guardar cotización</Button>`}>
        <Variant label="Variantes">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primario</Button>
            <Button>Secundario</Button>
            <Button variant="ghost">Fantasma</Button>
            <Button variant="danger">Eliminar</Button>
          </div>
        </Variant>
        <Variant label="Tamaños, icono y enlace">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Pequeño</Button>
            <Button size="sm" variant="primary" icon={<ArrowRight className="h-3.5 w-3.5" />}>
              Con icono
            </Button>
            <Button href="/finanzas" icon={<ArrowRight className="h-4 w-4" />}>
              Ir a Finanzas
            </Button>
          </div>
        </Variant>
        <Variant label="Cargando y deshabilitado">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading>
              Guardando
            </Button>
            <Button loading>Enviando recordatorio</Button>
            <Button disabled>Deshabilitado</Button>
          </div>
        </Variant>
        <Variant label="Texto largo">
          <Button variant="primary">Enviar recordatorio a Distribuidora Nacional de Alimentos S.A.S.</Button>
        </Variant>
      </Section>

      <Section id="pill" title="Pill" usage={`<Pill kind="bad">Vencida · 41 días</Pill>`}>
        <Variant label="Tipos">
          <div className="flex flex-wrap items-center gap-2">
            <Pill kind="good">Pagada</Pill>
            <Pill kind="warn">Vence en 3 días</Pill>
            <Pill kind="bad">Vencida · 41 días</Pill>
            <Pill kind="neutral">Borrador</Pill>
          </div>
        </Variant>
        <Variant label="Texto largo">
          <Pill kind="warn">Esperando aprobación de Distribuidora Nacional de Alimentos</Pill>
        </Variant>
      </Section>

      <Section
        id="form"
        title="Formulario: Field, Input, Select, Textarea, MoneyInput, DateInput"
        usage={`<Field label="Monto" help="Sin IVA" error={errors.amount} required>\n  <MoneyInput value={amount} currency="COP" onChange={(v) => setAmount(v)} />\n</Field>`}
      >
        <Variant label="Normal, con ayuda, obligatorio; pulsa Validar para ver los errores">
          <FormDemo />
        </Variant>
        <Variant label="Deshabilitado">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Field label="Marca">
              <Input disabled defaultValue="Café Alma" />
            </Field>
            <Field label="Monto">
              <MoneyInput value="1234567890.00" currency="COP" onChange={() => {}} disabled />
            </Field>
          </div>
        </Variant>
      </Section>

      <Section id="empty-state" title="EmptyState" usage={`<EmptyState title="Sin conexiones" description="Conecta una red para ver datos." action={{ label: "Conectar", href: "/conexiones" }} />`}>
        <Variant label="Con acción">
          <EmptyState title="Sin conexiones" description="Conecta TikTok, Instagram o YouTube para empezar a ver datos." action={{ label: "Conectar una red", href: "/conexiones" }} />
        </Variant>
        <Variant label="Solo título">
          <EmptyState title="Nada por cobrar" />
        </Variant>
      </Section>

      <Section id="data-as-of" title="DataAsOf" usage={`<DataAsOf date="2026-09-20T00:00:00Z" source="Instagram" />`}>
        <Variant label="Con y sin fuente">
          <div className="space-y-1">
            <DataAsOf date="2026-09-20T00:00:00Z" source="Instagram" />
            <DataAsOf date="2026-09-18T23:30:00Z" source="CSV de TikTok Studio" />
            <DataAsOf date="2026-01-05" />
          </div>
        </Variant>
      </Section>

      <Section id="kpi" title="Kpi / KpiRow" usage={`<KpiRow>\n  <Kpi label="Cobrado en 2026" value="COP 38,6 M" delta={0.31} deltaLabel="vs. mismo período 2025" />\n</KpiRow>`}>
        <Variant label="Finanzas (cifras del mock)">
          <KpiRow>
            <Kpi label="Por cobrar" value="COP 9,4 M" note="3 facturas" href="/finanzas" />
            <Kpi label="Vencido" value="COP 1,1 M" note="1 factura · 41 días" />
            <Kpi label="Cobrado en 2026" value="COP 38,6 M" delta={0.31} deltaLabel="vs. mismo período 2025" />
            <Kpi label="Apartado para impuestos" value="COP 4,2 M" note="11 % de cada cobro" />
          </KpiRow>
        </Variant>
        <Variant label="Con sparkline, delta negativo y plano">
          <KpiRow>
            <Kpi label="Seguidores" value="412 mil" delta={0.042} deltaLabel="vs. 30 días antes" sparkline={[380, 384, 390, 388, 395, 401, 404, 412]} />
            <Kpi label="Views en 30 días" value="9,8 M" delta={-0.117} deltaLabel="vs. 30 días antes" sparkline={[11.2, 10.9, 10.1, 10.4, 9.7, 9.9, 9.8]} />
            <Kpi label="Alcance en no seguidores" value="63 %" delta={0} deltaLabel="sin cambio" />
            <Kpi label="Guardados por mil" value="14,2" trend="up" delta={0.08} note="Mejor semana del trimestre" />
          </KpiRow>
        </Variant>
        <Variant label="Cargando y valores largos">
          <KpiRow>
            <Kpi label="Por cobrar" value="" loading />
            <Kpi label="Cobrado en 2026" value="" loading />
            <Kpi label="Cobrado desde el inicio" value="COP 1.234.567.890" note="Distribuidora Nacional de Alimentos S.A.S." />
            <Kpi label="Un valor y una nota que no caben en una línea" value="COP 1.234.567.890,50" delta={1.234} deltaLabel="vs. Distribuidora Nacional de Alimentos S.A.S. en 2025" />
          </KpiRow>
        </Variant>
      </Section>

      <Section
        id="data-table"
        title="DataTable"
        usage={`<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Cuentas por cobrar" emptyState={<EmptyState title="Nada por cobrar" />} onRowClick={open} />`}
      >
        <Variant label="La tabla CXC del mock, con fila clicable">
          <TableDemo />
        </Variant>
        <Variant label="Vacía">
          <DataTable
            columns={[
              { key: "brand", header: "Marca" },
              { key: "amount", header: "Monto", align: "num" },
            ]}
            rows={[]}
            rowKey={() => ""}
            caption="Cuentas por cobrar"
            emptyState={<EmptyState title="Nada por cobrar" description="Cuando aceptes una cotización, la factura aparece aquí." action={{ label: "Ir a Cotizar", href: "/cotizar" }} />}
          />
        </Variant>
        <Variant label="Cargando, con caption visible y densidad normal">
          <DataTable
            columns={[
              { key: "brand", header: "Marca" },
              { key: "campaign", header: "Campaña" },
              { key: "amount", header: "Monto", align: "num" },
            ]}
            rows={[]}
            rowKey={() => ""}
            caption="Cuentas por cobrar · cargando"
            showCaption
            density="normal"
            emptyState={null}
            loading
          />
        </Variant>
        <Variant label="Valores largos">
          <DataTable
            columns={[
              { key: "brand", header: "Marca", render: (r: { brand: string; sub: string; amount: string }) => <CellMain sub={r.sub}>{r.brand}</CellMain> },
              { key: "amount", header: "Monto", align: "num" },
            ]}
            rows={[{ brand: "Distribuidora Nacional de Alimentos S.A.S.", sub: "Campaña de lanzamiento de la línea de productos veganos del segundo semestre", amount: "COP 1.234.567.890,50" }]}
            rowKey={(r) => r.brand}
            caption="Valores largos"
            emptyState={null}
          />
        </Variant>
      </Section>
    </>
  );
}
