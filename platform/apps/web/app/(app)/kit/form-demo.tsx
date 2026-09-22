"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";

/** Formulario de ejemplo para la galería: el estado y los errores viven en el que usa el kit. */
export function FormDemo() {
  const [amount, setAmount] = useState("5200000.00");
  const [due, setDue] = useState("2026-10-15");
  const [stage, setStage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const errors = submitted
    ? {
        stage: stage ? undefined : "Elige una etapa",
        amount: amount && Number(amount) > 0 ? undefined : "Escribe un monto mayor a cero",
      }
    : {};
  return (
    <form
      className="grid max-w-xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
      }}
      noValidate
    >
      <Field label="Marca" help="Como aparece en la factura" required>
        <Input placeholder="Café Alma" defaultValue="Distribuidora Nacional de Alimentos S.A.S." />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Monto" help="Sin IVA" error={errors.amount} required>
          <MoneyInput value={amount} currency="COP" onChange={(v) => setAmount(v)} />
        </Field>
        <Field label="Vence" error={undefined}>
          <DateInput value={due} onChange={setDue} />
        </Field>
      </div>
      <Field label="Etapa" error={errors.stage} required>
        <Select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          placeholder="Elige una etapa"
          options={[
            { value: "nuevo", label: "Nuevo" },
            { value: "propuesta", label: "Propuesta enviada" },
            { value: "ganado", label: "Ganado" },
          ]}
        />
      </Field>
      <Field label="Notas" help="Opcional">
        <Textarea placeholder="Qué acordaron y cuándo vuelven a hablar" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary">
          Validar
        </Button>
        <Button
          type="button"
          onClick={() => {
            setSubmitted(false);
            setStage("");
            setAmount("");
          }}
        >
          Limpiar
        </Button>
        <span className="font-mono text-xs text-muted">
          value=&quot;{amount}&quot; · due=&quot;{due}&quot;
        </span>
      </div>
    </form>
  );
}

/** Controles deshabilitados. Vive aquí porque MoneyInput exige onChange y una función no cruza la frontera servidor → cliente. */
export function FormDisabledDemo() {
  return (
    <div className="grid max-w-xl gap-4 sm:grid-cols-2">
      <Field label="Marca">
        <Input disabled defaultValue="Café Alma" />
      </Field>
      <Field label="Monto">
        <MoneyInput value="1234567890.00" currency="COP" onChange={() => {}} disabled />
      </Field>
    </div>
  );
}
