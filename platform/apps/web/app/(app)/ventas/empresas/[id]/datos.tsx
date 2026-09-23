"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Aviso } from "../../_componentes/aviso";
import { MESSAGES } from "../../_lib/messages";
import type { CountryOption } from "../../_lib/paises";
import { EmpresaForm, type EmpresaEditable } from "../nueva/form";

/** Una fila de la tarjeta de datos, ya formateada en el servidor. */
export interface DatoFila {
  label: string;
  value: string | null;
}

/**
 * La tarjeta de datos de la ficha con su «Editar» (VEN-1).
 *
 * Los valores llegan ya formateados del servidor (el país por su nombre,
 * las fechas con la zona del espacio); aquí solo se decide si se ve la
 * tarjeta o el formulario. Al guardar, la acción revalida la ficha y la
 * tarjeta vuelve con los datos nuevos y el aviso de que se guardó.
 */
export function DatosEmpresa({
  company,
  countries,
  filas,
  signalsLink,
}: {
  company: EmpresaEditable;
  /** Las opciones de país del formulario, con el nombre en el idioma del workspace. */
  countries: CountryOption[];
  filas: DatoFila[];
  /** «2 señales en el radar», si las hay. */
  signalsLink: string | null;
}) {
  const t = MESSAGES.empresas.detail;
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  return (
    <section aria-labelledby="empresa-datos" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="empresa-datos" className="text-sm font-semibold">
          {editing ? MESSAGES.empresas.form.editTitle : t.data}
        </h2>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(true);
              setNotice(undefined);
            }}
            aria-label={t.editLabel(company.name)}
          >
            {t.edit}
          </Button>
        )}
      </div>

      {editing ? (
        <EmpresaForm
          company={company}
          countries={countries}
          onCancel={() => setEditing(false)}
          onSaved={(msg) => {
            setNotice(msg);
            setEditing(false);
          }}
        />
      ) : (
        <>
          {notice && <Aviso notice={notice} />}
          <dl className="space-y-3 rounded-md border border-border p-4 text-sm">
            {filas.map((f) => (
              <div key={f.label} className="flex justify-between gap-3">
                <dt className="text-muted">{f.label}</dt>
                <dd className="min-w-0 break-words text-right text-ink">{f.value ?? t.empty}</dd>
              </div>
            ))}
            {signalsLink && (
              <div>
                <dt className="sr-only">{MESSAGES.tabs.radar}</dt>
                <dd>
                  <Link href="/ventas" className="text-xs text-ink underline underline-offset-4 hover:text-ink-2">
                    {signalsLink}
                  </Link>
                </dd>
              </div>
            )}
          </dl>
          <div>
            <h3 className="mb-1.5 text-sm font-semibold">{t.notes}</h3>
            <p className="whitespace-pre-line text-sm leading-6 text-ink-2">
              {company.notes ?? <span className="text-muted">{t.noNotes}</span>}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
