"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Aviso } from "../../../_lib/aviso";
import { enrolarDesdeNegocio, type EnrolarState } from "../actions";
import { MESSAGES } from "../messages";

export interface NegocioVista {
  id: string;
  label: string;
  /** `dentro`: ya está en esta cadencia; se ve, con «Ya está dentro», pero no se marca. */
  personas: Array<{ id: string; nombre: string; detalle: string; disponible: boolean; dentro: boolean }>;
}

/**
 * «Enrolar desde un negocio»: se elige el negocio y sus personas, y cada
 * una entra en la cadencia (enrollContacts de VEN-10). Quien pidió la
 * baja, no llega por ningún canal con el que la cadencia escribe, ya está
 * dentro o sigue viva en otra cadencia se ve, con el motivo, pero no se
 * puede marcar; si nadie del negocio puede entrar, «Enrolar» se apaga y
 * lo dice. Tras enrolar, cada persona que entró dice qué le queda.
 */
export function Enrolar({ sequenceId, negocios, activa, inicial }: {
  sequenceId: string;
  negocios: NegocioVista[];
  activa: boolean;
  /** El negocio de la señal, si la cadencia salió de una. */
  inicial: string | null;
}) {
  const t = MESSAGES.enrolar;
  const [negocio, setNegocio] = useState(inicial && negocios.some((n) => n.id === inicial) ? inicial : "");
  const [state, action, pending] = useActionState<EnrolarState, FormData>(enrolarDesdeNegocio.bind(null, sequenceId), {});
  const elegido = negocios.find((n) => n.id === negocio);
  // Con el negocio elegido y nadie que pueda entrar (ya dentro, de baja, sin dirección o en otra cadencia), no hay nada que enviar.
  const nadie = elegido !== undefined && elegido.personas.length > 0 && !elegido.personas.some((p) => p.disponible);

  return (
    <section aria-labelledby="enrolar" className="rounded-md border border-line bg-surface p-4">
      <h2 id="enrolar" className="text-sm font-semibold">
        {t.titulo}
      </h2>
      <p className="mt-1 text-xs text-fg-2">{t.descripcion}</p>
      {negocios.length === 0 ? (
        <p className="mt-3 text-sm text-fg-3">{t.sinNegocios}</p>
      ) : (
        <form action={action} className="mt-3 grid gap-3">
          <Field label={t.negocio}>
            <Select
              name="dealId"
              options={negocios.map((n) => ({ value: n.id, label: n.label }))}
              placeholder={t.negocioPlaceholder}
              value={negocio}
              onChange={(e) => setNegocio(e.target.value)}
              required
            />
          </Field>
          {elegido && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t.personas}</legend>
              {elegido.personas.length === 0 && <p className="text-sm text-fg-3">{t.sinPersonas}</p>}
              {elegido.personas.map((p) => (
                <label key={p.id} className={`flex items-start gap-2 text-sm ${p.disponible ? "" : "text-fg-3"}`}>
                  <input
                    type="checkbox"
                    name="contactId"
                    value={p.id}
                    disabled={!p.disponible}
                    defaultChecked={p.disponible && elegido.personas.filter((x) => x.disponible).length === 1}
                    className="mt-0.5 size-4 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block break-words">{p.nombre}</span>
                    <span className="block text-xs text-fg-3 break-words">{p.detalle}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <Button type="submit" size="sm" loading={pending} disabled={!activa || !elegido || nadie}>
              {pending ? t.enrolando : t.boton}
            </Button>
            {!activa && <p className="mt-2 text-xs text-fg-3">{t.soloActiva}</p>}
            {activa && nadie && <p className="mt-2 text-xs text-fg-3">{t.nadieDisponible}</p>}
          </div>
          <Aviso message={state.error} notice={state.ok} size="xs" />
          {state.dentro && state.dentro.length > 0 && (
            <ul className="grid gap-1 text-xs tabular-nums text-fg-2">
              {state.dentro.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          {state.saltadas && state.saltadas.length > 0 && (
            <ul className="grid gap-1 text-xs text-fg-2">
              {state.saltadas.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </form>
      )}
    </section>
  );
}
