import { describe, expect, it } from "vitest";
import { MESSAGES as ACTIVIDAD } from "../actividad/messages";
import { MESSAGES as APROBACIONES } from "../aprobaciones/messages";
import { MESSAGES as BANDEJA } from "../bandeja/messages";
import { MESSAGES as CADENCIAS } from "../cadencias/messages";
import { MESSAGES as CANALES } from "../canales/messages";
import { PITCH } from "../empresas/[id]/pitch/messages";
import { MESSAGES as PERFIL } from "../perfil/messages";
import { MESSAGES as POLITICA } from "../politica/messages";
import { MESSAGES } from "./messages";

/**
 * Pulido r6: el título de pestaña de toda pantalla de Ventas sigue un solo
 * patrón, «X · Ventas» (el layout raíz añade « · On Cue»). Antes Perfil,
 * Política, Canales, Cadencias, Aprobaciones, Bandeja y Actividad decían
 * «X · On Cue» y no se sabía de qué módulo era cada pestaña.
 */
describe("el título de pestaña de Ventas", () => {
  it("toda pantalla del módulo termina en « · Ventas»", () => {
    const titulos = [
      MESSAGES.empresas.metaTitle,
      MESSAGES.empresas.form.metaTitle,
      MESSAGES.brief.metaTitle,
      PERFIL.metaTitle,
      POLITICA.metaTitle,
      CANALES.meta.title,
      CADENCIAS.metaTitle,
      CADENCIAS.detalle.metaTitle("Marca con campaña activa"),
      APROBACIONES.metaTitle,
      BANDEJA.metaTitle,
      ACTIVIDAD.metaTitle,
      PITCH.metaTitle("Café Alma"),
      PITCH.metaTitleFallback,
    ];
    for (const t of titulos) expect(t).toMatch(/ · Ventas$/);
    expect(MESSAGES.header.metaTitle).toBe("Ventas");
  });
});
