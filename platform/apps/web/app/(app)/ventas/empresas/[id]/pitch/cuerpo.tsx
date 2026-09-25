"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import type { SalesClaim } from "@mc/core/outreach/claims";
import { figureIssueSpans, type FigureIssue } from "@mc/core/outreach/preflight";
import { isTemplateVariable } from "@mc/core/outreach/render";
import { CONTROL } from "@/components/ui/field";
import { markedOf, pushText, segmentsOf, withSpacing, type Segment } from "./marcas";
import { PITCH } from "./messages";

/** Lo que el editor le pide al cuerpo: insertar una ficha donde está el cursor, y el foco. */
export interface CuerpoApi {
  insert(piece: Segment[]): void;
  focus(): void;
}

type Chip = Exclude<Segment, { kind: "text" }>;

const CHIP =
  "mx-0.5 inline-flex cursor-default items-baseline rounded border px-1.5 align-baseline text-sm leading-5 tabular-nums";
const CHIP_CLAIM = `${CHIP} border-border bg-surface-2 font-medium text-ink`;
const CHIP_UNKNOWN = `${CHIP} border-bad bg-surface font-medium text-bad`;
const CHIP_VARIABLE = `${CHIP} border-dashed border-axis bg-surface text-ink-2`;

/** Una ficha dentro del mensaje: no se edita por dentro, se borra entera. El origen, en el title y en la etiqueta accesible. */
function chipNode(doc: Document, s: Chip, claims: ReadonlyMap<string, SalesClaim>): HTMLElement {
  const el = doc.createElement("span");
  el.setAttribute("contenteditable", "false");
  if (s.kind === "claim") {
    const c = claims.get(s.id);
    const shown = s.raw || c?.display || "·";
    el.dataset.claim = s.id;
    el.dataset.raw = s.raw;
    el.textContent = shown;
    const label = c ? PITCH.cuerpo.cifra(shown, c.label, PITCH.origen[c.source]) : PITCH.cuerpo.cifraDesconocida(shown);
    el.title = label;
    el.setAttribute("aria-label", label);
    el.className = c ? CHIP_CLAIM : CHIP_UNKNOWN;
  } else {
    const label = PITCH.variables[s.name];
    el.dataset.variable = s.name;
    el.textContent = label;
    el.title = PITCH.cuerpo.variable(label);
    el.setAttribute("aria-label", PITCH.cuerpo.variable(label));
    el.className = CHIP_VARIABLE;
  }
  return el;
}

function nodesOf(doc: Document, segments: readonly Segment[], claims: ReadonlyMap<string, SalesClaim>): Node[] {
  return segments.map((s) => (s.kind === "text" ? doc.createTextNode(s.text) : chipNode(doc, s, claims)));
}

/**
 * El salto de línea del final: con white-space pre-wrap, un «\n» al final
 * no se ve si no hay nada detrás. Este <br> no es parte del mensaje.
 */
function ensureTail(root: HTMLElement): void {
  const last = root.lastChild;
  if (last instanceof HTMLElement && last.dataset.fin !== undefined) return;
  root.querySelectorAll("[data-fin]").forEach((n) => n.remove());
  const br = root.ownerDocument.createElement("br");
  br.dataset.fin = "";
  root.appendChild(br);
}

/** Lee lo que hay en el editor: el texto, las fichas y los saltos de línea que meta el navegador (<br>, <div>). */
function readSegments(root: Node, out: Segment[] = []): Segment[] {
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(out, (node.textContent ?? "").replace(/\u00a0/g, " "));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.fin !== undefined) return;
    if (node.dataset.claim) {
      out.push({ kind: "claim", id: node.dataset.claim, raw: node.dataset.raw ?? "" });
    } else if (node.dataset.variable && isTemplateVariable(node.dataset.variable)) {
      out.push({ kind: "variable", name: node.dataset.variable });
    } else if (node.tagName === "BR") {
      pushText(out, "\n");
    } else if (node.tagName === "DIV" || node.tagName === "P") {
      const last = out.at(-1);
      if (out.length > 0 && !(last?.kind === "text" && last.text.endsWith("\n"))) pushText(out, "\n");
      readSegments(node, out);
    } else {
      readSegments(node, out);
    }
  });
  return out;
}

/** El nombre del resaltado de las cifras sin origen (CSS Custom Highlight API): se pinta sin tocar el DOM ni mover el cursor. */
const FLAG_HIGHLIGHT = "pitch-cifra-sin-origen";
/** Subrayado ondulado con el color semántico de error (--bad, de globals.css), claro y oscuro. */
const FLAG_CSS = `::highlight(${FLAG_HIGHLIGHT}){text-decoration-line:underline;text-decoration-style:wavy;text-decoration-color:var(--bad);background-color:var(--bad-wash);}`;

/**
 * Dónde empieza cada nodo de texto del cuerpo dentro del texto marcado:
 * se recorre el DOM como readSegments y se reconstruye el marcado a la
 * vez (una ficha de cifra cuenta lo que escribe «115.446 [claim:…]», una
 * variable «{{first_name}}»). Si lo reconstruido no es `marked`, null.
 */
function textOffsets(root: HTMLElement, marked: string): Array<{ node: Text; start: number }> | null {
  const out: Array<{ node: Text; start: number }> = [];
  let text = "";
  const walk = (parent: Node) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push({ node: node as Text, start: text.length });
        text += (node.textContent ?? "").replace(/\u00a0/g, " ");
        return;
      }
      if (!(node instanceof HTMLElement) || node.dataset.fin !== undefined) return;
      if (node.dataset.claim) {
        const raw = node.dataset.raw ?? "";
        text += raw ? `${raw} [claim:${node.dataset.claim}]` : ` [claim:${node.dataset.claim}]`;
      } else if (node.dataset.variable && isTemplateVariable(node.dataset.variable)) {
        text += `{{${node.dataset.variable}}}`;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        if (text.length > 0 && !text.endsWith("\n")) text += "\n";
        walk(node);
      } else {
        walk(node);
      }
    });
  };
  walk(root);
  return text === marked ? out : null;
}

/** Subraya dentro del mensaje las cifras sin origen o que no coinciden con él. Sin la API de resaltado, no hace nada (queda el aviso). */
function paintFlagged(root: HTMLElement, marked: string, flagged: readonly FigureIssue[]): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  const offsets = flagged.length > 0 ? textOffsets(root, marked) : null;
  const at = (pos: number) => {
    const piece = offsets?.findLast((o) => o.start <= pos && pos <= o.start + (o.node.textContent ?? "").length);
    return piece ? { node: piece.node, offset: pos - piece.start } : null;
  };
  const ranges: Range[] = [];
  for (const f of flagged) {
    const a = at(f.start);
    const b = at(f.end);
    if (!a || !b) continue;
    const r = root.ownerDocument.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    ranges.push(r);
  }
  if (ranges.length > 0) CSS.highlights.set(FLAG_HIGHLIGHT, new Highlight(...ranges));
  else CSS.highlights.delete(FLAG_HIGHLIGHT);
}

/**
 * El cuerpo del pitch: un campo de texto en el que las cifras de tu
 * perfil y las variables son fichas (como en el compositor de Superhuman),
 * no marcas técnicas. `value` es el texto marcado («115.446
 * [claim:…]», «{{first_name}}»): es lo que se guarda y lo que revisa el
 * pre-vuelo, y va al formulario en un campo oculto con el nombre `name`.
 *
 * Es un contenteditable que React no pinta por dentro: se pinta desde
 * `value` cuando cambia desde fuera (un borrador de la IA, una ficha
 * insertada) y se lee en cada tecla. Así el cursor no salta mientras se
 * escribe. Pegar pega texto sin formato, y Enter es un salto de línea.
 */
export function CuerpoConCifras({
  id,
  name,
  value,
  onChange,
  claims,
  labelledBy,
  describedBy,
  api,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (marked: string) => void;
  claims: readonly SalesClaim[];
  labelledBy: string;
  describedBy?: string;
  api?: Ref<CuerpoApi>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const lastValue = useRef<string | null>(null);
  const renderedClaims = useRef<ReadonlyMap<string, SalesClaim> | null>(null);
  const byId = useMemo<ReadonlyMap<string, SalesClaim>>(() => new Map(claims.map((c) => [c.id, c])), [claims]);

  // Se pinta desde fuera solo si el texto no es el que la persona acaba de escribir (o si cambian las cifras que se pueden citar).
  useEffect(() => {
    const root = ref.current;
    if (!root || (value === lastValue.current && byId === renderedClaims.current)) return;
    root.replaceChildren(...nodesOf(root.ownerDocument, segmentsOf(value), byId));
    ensureTail(root);
    lastValue.current = value;
    renderedClaims.current = byId;
  }, [value, byId]);

  // Las cifras sin origen (o con un origen que no coincide), subrayadas donde están y dichas justo debajo (§5.3).
  const flagged = useMemo(() => figureIssueSpans(value, claims), [value, claims]);
  useEffect(() => {
    if (ref.current) paintFlagged(ref.current, value, flagged);
  }, [value, flagged]);
  useEffect(
    () => () => {
      if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(FLAG_HIGHLIGHT);
    },
    [],
  );
  const flaggedId = `${id}-cifras`;
  const flaggedList = [...new Set(flagged.map((f) => `«${value.slice(f.start, f.end)}»`))];

  // Dónde está el cursor dentro del cuerpo: ahí se insertan las fichas aunque el foco se haya ido al botón.
  useEffect(() => {
    const onSelection = () => {
      const sel = document.getSelection();
      const root = ref.current;
      if (root && sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  function emit() {
    const root = ref.current;
    if (!root) return;
    ensureTail(root);
    const marked = markedOf(readSegments(root));
    lastValue.current = marked;
    onChange(marked);
  }

  /** Inserta trozos donde estaba el cursor (o al final) y deja el cursor detrás. */
  function insertAtCaret(pieces: (before: string, after: string) => Segment[]) {
    const root = ref.current;
    if (!root) return;
    const doc = root.ownerDocument;
    let range = saved.current && root.contains(saved.current.startContainer) ? saved.current : null;
    if (!range) {
      range = doc.createRange();
      const tail = root.querySelector("[data-fin]");
      if (tail) range.setStartBefore(tail);
      else range.selectNodeContents(root);
      range.collapse(true);
    }
    const head = doc.createRange();
    head.setStart(root, 0);
    head.setEnd(range.startContainer, range.startOffset);
    const rest = doc.createRange();
    rest.setStart(range.endContainer, range.endOffset);
    rest.setEnd(root, root.childNodes.length);
    const nodes = nodesOf(doc, pieces(head.toString(), rest.toString()), byId);
    range.deleteContents();
    const frag = doc.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    const last = nodes.at(-1);
    range.insertNode(frag);
    root.focus();
    if (last) {
      const caret = doc.createRange();
      caret.setStartAfter(last);
      caret.collapse(true);
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(caret);
      saved.current = caret.cloneRange();
    }
    emit();
  }

  useImperativeHandle(api, () => ({
    insert: (piece) => insertAtCaret((before, after) => withSpacing(before, after, piece)),
    focus: () => ref.current?.focus(),
  }));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      insertAtCaret(() => [{ kind: "text", text: "\n" }]);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (text) insertAtCaret(() => segmentsOf(text));
  }

  return (
    <>
      <div
        ref={ref}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelledBy}
        aria-describedby={[describedBy, flagged.length > 0 ? flaggedId : null].filter(Boolean).join(" ") || undefined}
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        spellCheck
        onInput={emit}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={(e) => e.preventDefault()}
        className={`${CONTROL} min-h-72 whitespace-pre-wrap break-words py-2 leading-7`}
      />
      <input type="hidden" name={name} value={value} />
      <style>{FLAG_CSS}</style>
      {flagged.length > 0 && (
        <p id={flaggedId} className="min-w-0 break-words text-xs text-bad">
          {PITCH.cuerpo.cifrasSinOrigen(flaggedList.join(", "), flaggedList.length)}
        </p>
      )}
    </>
  );
}
