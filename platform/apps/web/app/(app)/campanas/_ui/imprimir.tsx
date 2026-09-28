"use client";

import { Button } from "@/components/ui/button";
import { MESSAGES } from "../_lib/messages";

/**
 * «Descargar PDF» sin dependencia nueva: abre el diálogo de impresión
 * del navegador, que en todos los de escritorio y en iOS ofrece
 * «Guardar como PDF». Lo que sale es la propia página con su
 * @media print (globals.css): sin botones, sin sombras, un salto entre
 * secciones. Es lo único de cliente en el documento.
 */
export function BotonImprimir({ className = "" }: { className?: string }) {
  const t = MESSAGES.reporte;
  return (
    <span className={`no-print inline-flex flex-wrap items-center gap-2 ${className}`}>
      <Button variant="secondary" size="sm" onClick={() => window.print()}>
        {t.descargarPdf}
      </Button>
      <span className="text-xs text-muted">{t.descargarPdfAyuda}</span>
    </span>
  );
}
