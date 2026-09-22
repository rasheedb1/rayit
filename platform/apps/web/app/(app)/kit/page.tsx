import type { Metadata } from "next";
import { requireModule } from "@/content/modules";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Pill } from "@/components/ui/pill";
import { FormDemo } from "./form-demo";
import { Section, Variant } from "./section";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = { title: "Kit de interfaz" };

const SECTIONS = [
  ["button", "Button"],
  ["pill", "Pill"],
  ["form", "Formulario"],
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
    </>
  );
}
