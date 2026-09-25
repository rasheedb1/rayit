/**
 * El mensaje del pitch como lo ve la persona: texto y fichas (VEN-6
 * dentro de VEN-12). Puro y probado.
 *
 * Por dentro, el mensaje es texto con marcas: «115.446 [claim:baseline:
 * tiktok:median_views] views» y «Hola {{first_name}}». Eso es lo que se
 * guarda (con sus variables sin rellenar, 0058) y lo que corre el
 * pre-vuelo. La persona nunca ve una marca: la cifra con su origen es una
 * ficha que dice «115.446» (el origen, al pasar el cursor) y la variable,
 * una ficha que dice «Nombre de la persona». Como el compositor de
 * Superhuman: lo técnico no se ve.
 *
 * Aquí se parte el texto en trozos y se vuelve a unir; el editor
 * (cuerpo.tsx) pinta los trozos y lee lo que la persona escribe.
 */
import { findClaimMarkers, findFigures } from "@mc/core/outreach/claims";
import { MARKER_REACH } from "@mc/core/outreach/preflight";
import { isTemplateVariable, type TemplateVariable } from "@mc/core/outreach/render";

export type Segment =
  | { kind: "text"; text: string }
  /** Una cifra con su origen: `raw` es la cifra tal como se escribió («115.446», «el triple»); vacía si la marca iba sola. */
  | { kind: "claim"; id: string; raw: string }
  | { kind: "variable"; name: TemplateVariable };

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Añade texto al final, juntándolo con el trozo de texto anterior si lo hay. */
export function pushText(out: Segment[], text: string): void {
  if (!text) return;
  const last = out.at(-1);
  if (last?.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

/** Un trozo de texto sin marcas de cifra: las variables conocidas salen como fichas; las desconocidas se quedan como texto (son huecos). */
function textWithVariables(out: Segment[], text: string): void {
  let pos = 0;
  for (const m of text.matchAll(VARIABLE_RE)) {
    const name = m[1]!;
    if (!isTemplateVariable(name)) continue;
    pushText(out, text.slice(pos, m.index));
    out.push({ kind: "variable", name });
    pos = (m.index ?? 0) + m[0].length;
  }
  pushText(out, text.slice(pos));
}

/**
 * Parte un mensaje marcado en trozos. Cada marca [claim:id] se lleva la
 * cifra que la precede (la misma que el pre-vuelo le atribuye: a
 * MARKER_REACH como mucho y sin saltar de línea) y juntas son una ficha.
 * Si entre la cifra y la marca había texto («115.446 views [claim:x]»),
 * ese texto queda detrás de la ficha: lo que ve la marca no cambia.
 */
export function segmentsOf(marked: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const m of findClaimMarkers(marked)) {
    const before = marked.slice(pos, m.start);
    const f = findFigures(before).at(-1);
    if (f && m.start - (pos + f.end) <= MARKER_REACH && !before.slice(f.end).includes("\n")) {
      textWithVariables(out, before.slice(0, f.start));
      out.push({ kind: "claim", id: m.id, raw: before.slice(f.start, f.end) });
      textWithVariables(out, before.slice(f.end));
    } else {
      textWithVariables(out, before);
      out.push({ kind: "claim", id: m.id, raw: "" });
    }
    pos = m.end;
  }
  textWithVariables(out, marked.slice(pos));
  return out;
}

/** Une los trozos en el texto marcado que se guarda y que revisa el pre-vuelo. */
export function markedOf(segments: readonly Segment[]): string {
  return segments
    .map((s) => {
      if (s.kind === "text") return s.text;
      if (s.kind === "variable") return `{{${s.name}}}`;
      return s.raw ? `${s.raw} [claim:${s.id}]` : ` [claim:${s.id}]`;
    })
    .join("");
}

/**
 * Lo que se inserta con una ficha: la ficha y, si hace falta, un espacio
 * delante y otro detrás (no se pega a la palabra de al lado). Al final
 * del texto no se añade espacio detrás: lo siguiente puede ser una coma.
 */
export function withSpacing(before: string, after: string, piece: Segment[]): Segment[] {
  const lead = before && !/\s$/.test(before) ? [{ kind: "text" as const, text: " " }] : [];
  const trail = after.trim() && !/^[\s.,;:!?)]/.test(after) ? [{ kind: "text" as const, text: " " }] : [];
  return [...lead, ...piece, ...trail];
}
