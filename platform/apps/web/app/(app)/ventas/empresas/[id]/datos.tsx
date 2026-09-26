"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Aviso } from "../../../_lib/aviso";
import { MESSAGES } from "../../_lib/messages";
import type { CountryOption } from "../../_lib/paises";
import { EmpresaForm, type EmpresaEditable } from "../nueva/form";
import { Bloque } from "./bloque";

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
  signalsLinks,
}: {
  company: EmpresaEditable;
  /** Las opciones de país del formulario, con el nombre en el idioma del workspace. */
  countries: CountryOption[];
  filas: DatoFila[];
  /**
   * «2 señales en el radar» → /ventas y, si el brief deja alguna fuera,
   * «1 señal oculta por tu brief» → /ventas?ocultas=1. Vacío si no hay.
   */
  signalsLinks: { text: string; href: string }[];
}) {
  const t = MESSAGES.empresas.detail;
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  // Un bloque que se pliega, como el resto de la ficha (patrón Attio).
  // «Editar» va dentro, no en el título: el título es el botón que
  // pliega el bloque, y un botón dentro de otro no se anuncia. Va donde
  // «Negocios» y «Contactos» ponen su acción: lo primero del cuerpo, a la
  // izquierda y secundario. Solo y a la derecha, encima de la tarjeta,
  // parecía un botón perdido.
  return (
    <Bloque id="empresa-datos" title={editing ? MESSAGES.empresas.form.editTitle : t.data}>
      <div className="space-y-3">
        {!editing && (
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditing(true);
                setNotice(undefined);
              }}
              aria-label={t.editLabel(company.name)}
            >
              {t.edit}
            </Button>
          </div>
        )}

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
              {signalsLinks.length > 0 && (
                <div>
                  <dt className="sr-only">{MESSAGES.tabs.radar}</dt>
                  {signalsLinks.map((l) => (
                    <dd key={l.href}>
                      <Link href={l.href} className="text-xs text-ink underline underline-offset-4 hover:text-ink-2">
                        {l.text}
                      </Link>
                    </dd>
                  ))}
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
      </div>
    </Bloque>
  );
}
