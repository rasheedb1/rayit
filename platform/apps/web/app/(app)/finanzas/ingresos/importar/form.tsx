"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PlatformPill } from "@/components/ui/platform-pill";
import { importarCsv, type ImportarState } from "../actions";
import { MESSAGES } from "../_lib/messages";
import type { Problema } from "../_lib/csv";

const T = MESSAGES.importar;

/** La frase de un problema, con el número de fila delante cuando lo hay. */
function frase(p: Problema): string {
  const texto = T.validacion[p.codigo](p.valor);
  return p.fila > 0 ? `Fila ${p.fila}: ${texto}` : texto;
}

function Problemas({ problemas }: { problemas: Problema[] }) {
  if (problemas.length === 0) return null;
  const errores = problemas.filter((p) => p.gravedad === "error");
  const avisos = problemas.filter((p) => p.gravedad === "aviso");
  return (
    <div className="mt-4 space-y-3 text-sm">
      {[
        { titulo: "No se cargaron", lista: errores, color: "text-bad" },
        { titulo: "Quedaron fuera", lista: avisos, color: "text-warn" },
      ]
        .filter((g) => g.lista.length > 0)
        .map((g) => (
          <div key={g.titulo}>
            <p className={`text-xs font-medium ${g.color}`}>
              {g.titulo} ({g.lista.length})
            </p>
            <ul className="mt-1 space-y-0.5 text-ink-2">
              {g.lista.map((p, i) => (
                <li key={`${p.fila}-${p.codigo}-${i}`} className="leading-5">
                  {frase(p)}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

export function ImportarForm({ currency }: { currency: string }) {
  const [state, formAction, pending] = useActionState<ImportarState, FormData>(importarCsv, {});
  const [nombre, setNombre] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const r = state.resultado;

  return (
    <div className="max-w-2xl">
      <form action={formAction} className="flex flex-col gap-4">
        <Field label={T.campo.label} help={T.campo.ayuda} error={state.message}>
          <input
            ref={inputRef}
            type="file"
            name="archivo"
            accept=".csv,text/csv"
            required
            onChange={(e) => setNombre(e.target.files?.[0]?.name ?? "")}
            className="block w-full cursor-pointer rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-sm file:border-0 file:bg-hover file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:bg-surface-2"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={pending} disabled={!nombre}>
            {pending ? T.enviando : T.enviar}
          </Button>
          <Button variant="ghost" href="/finanzas/ingresos">
            {MESSAGES.acciones.volver}
          </Button>
        </div>
      </form>

      {r && (
        <section
          aria-live="polite"
          className={`mt-6 rounded-md border p-4 ${state.ok ? "border-border bg-surface" : "border-border bg-surface"}`}
        >
          <p className="text-sm font-medium text-ink">{state.ok ? T.resultado.titulo : ""}</p>
          <ul className="mt-1 space-y-0.5 text-sm leading-5 text-ink-2">
            <li>{T.resultado.reconocido(T.formatos[r.formato])}</li>
            {r.escritos > 0 && <li className="font-medium text-ink">{T.resultado.escritos(r.escritos)}</li>}
            {state.ok && r.escritos === 0 && r.repetidos > 0 && <li>{T.resultado.nadaNuevo}</li>}
            {r.repetidos > 0 && r.escritos > 0 && <li>{T.resultado.repetidos(r.repetidos)}</li>}
            {r.agrupadas > 0 && <li>{T.resultado.agrupadas(r.agrupadas)}</li>}
            {r.monedaSupuesta && <li>{T.resultado.monedaSupuesta(r.moneda ?? currency)}</li>}
            {T.resultado.codificacion(r.codificacion) && <li>{T.resultado.codificacion(r.codificacion)}</li>}
          </ul>

          {r.conflictos.length > 0 && (
            <div className="mt-4 rounded-sm border border-warn/40 bg-warn-wash p-3">
              <p className="text-xs font-medium text-ink">{T.conflicto.titulo}</p>
              <p className="mt-1 text-sm leading-5 text-ink-2">{T.conflicto.explicacion}</p>
              <ul className="mt-2 space-y-1 text-sm text-ink-2">
                {r.conflictos.map((c) => (
                  <li key={`${c.platformId}-${c.periodStart}`} className="flex flex-wrap items-center gap-2">
                    <PlatformPill platformId={c.platformId} />
                    <span>{T.conflicto.fila(c.platformId, c.periodStart.slice(0, 7), c.existingAmount, c.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Problemas problemas={r.problemas} />

          {state.ok && (
            <div className="mt-4">
              <Button href="/finanzas/ingresos" variant="primary" size="sm">
                {MESSAGES.acciones.volver}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
