"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  narrativeIssueSpans, narrativeSegments, paragraphsOf, verifyNarrativeWith, type IssueSpan, type VerifierContext,
} from "@mc/core/outreach/narrativa";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { guardarNarrativa } from "./actions";
import { Cifra } from "./cifra";
import type { CifraVista } from "./cifras";
import { MESSAGES } from "./messages";
import { describirProblemas } from "./problemas";

const AREA_ID = "narrativa-texto";
const CIFRA_ID = "narrativa-cifra";
const SUBRAYADO = "rounded-sm bg-bad-wash text-fg underline decoration-bad decoration-wavy underline-offset-4";

/**
 * Un trozo de texto con los problemas del verificador subrayados. `desde`
 * es dónde empieza el trozo dentro de su párrafo: las posiciones de
 * narrativeIssueSpans son del párrafo entero.
 */
function subrayar(text: string, desde: number, spans: readonly IssueSpan[], clave: string): ReactNode[] {
  const fin = desde + text.length;
  const out: ReactNode[] = [];
  let cursor = desde;
  for (const sp of spans) {
    if (sp.end <= cursor || sp.start >= fin) continue;
    const a = Math.max(sp.start, cursor);
    const b = Math.min(sp.end, fin);
    if (a > cursor) out.push(text.slice(cursor - desde, a - desde));
    out.push(
      <mark key={`${clave}-${a}`} className={SUBRAYADO}>
        {text.slice(a - desde, b - desde)}
      </mark>,
    );
    cursor = b;
  }
  if (cursor < fin) out.push(text.slice(cursor - desde));
  return out;
}

/**
 * Párrafos con cada marca [claim:id] pintada como su cifra, con el mismo
 * parser de @mc/core que usa el servidor (narrativeSegments). Una marca
 * que ya no está en el perfil queda como texto tal cual: la pantalla no
 * inventa la cifra. Con `verificador` (la vista previa), además subraya
 * lo que el verificador rechazaría: una marca inventada, una cifra a
 * mano, una cantidad en letras.
 */
function Parrafos({
  texto, cifras, prefijo, verificador,
}: { texto: string; cifras: Record<string, CifraVista>; prefijo: string; verificador?: VerifierContext }) {
  const parrafos = paragraphsOf(texto);
  return (
    <div className="space-y-4 text-[15px] leading-7 text-fg">
      {narrativeSegments(texto, cifras).map((p, i) => {
        const spans = verificador ? narrativeIssueSpans(parrafos[i] ?? "", verificador) : [];
        let desde = 0;
        return (
          <p key={i}>
            {p.map((s, j) => {
              if (s.kind === "claim") {
                desde += `[claim:${s.id}]`.length;
                return <Cifra key={j} cifra={s.claim} tipId={`${prefijo}-${i}-${j}`} />;
              }
              const trozo = <span key={j}>{spans.length ? subrayar(s.text, desde, spans, `${i}-${j}`) : s.text}</span>;
              desde += s.text.length;
              return trozo;
            })}
          </p>
        );
      })}
    </div>
  );
}

/**
 * La narrativa del perfil: tres párrafos con cada cifra enlazada a su
 * origen, y «Editar» para corregirla si quien mira puede (editable). La
 * edición es el texto con sus marcas [claim:id], una lista para insertar
 * cifras donde está el cursor y, debajo, la vista previa en vivo con cada
 * marca ya convertida en su cifra y lo que el verificador rechazaría
 * subrayado (el mismo verifyNarrativeWith de @mc/core, en el cliente).
 * Al guardar pasa la puerta de verdad, en el servidor, y lo que rechaza
 * se dice en una lista, una línea por problema.
 *
 * La página la monta sin key: al guardar, revalidatePath trae la
 * narrativa nueva por props y el componente conserva su estado, así el
 * aviso «Narrativa guardada.» se queda en su región role=status en vez
 * de perderse con un remontaje. La fecha contra la que se guarda es la
 * que había al abrir el editor (base): si un recálculo cambió la
 * narrativa mientras se editaba, guardar no la pisa (stale_edit).
 */
export function Narrativa({
  texto, escritaEl, fuente, aviso, idioma, cifras, editable, verificador, maxTexto,
}: {
  texto: string;
  /** La fecha de la narrativa en pantalla: si cambió por detrás, guardar no la pisa. */
  escritaEl: string;
  /** «Redactada por claude-sonnet-5…», ya armada. */
  fuente: string;
  /** Por qué es de plantilla, si lo es. */
  aviso: string | null;
  /** «La narrativa se redacta en español.», ya armada con el idioma del workspace. */
  idioma: string;
  /** Los ids y términos del perfil: lo que el verificador de la vista previa necesita. */
  verificador: VerifierContext;
  /** El máximo de caracteres, escrito con el locale del workspace. */
  maxTexto: string;
  cifras: Record<string, CifraVista>;
  /** Si quien mira puede editarla (puedeEditarElPerfil): si no, no se ofrece «Editar». */
  editable: boolean;
}) {
  const t = MESSAGES.narrativa;
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState(texto);
  /** La fecha de la narrativa que se abrió para editar: contra ella se guarda. */
  const [base, setBase] = useState(escritaEl);
  const [elegida, setElegida] = useState("");
  const [error, setError] = useState<{ message: string; detalles: string[] } | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [guardando, empezar] = useTransition();
  const opciones = Object.values(cifras).map((c) => ({ value: c.id, label: `${c.que}: ${c.valor}` }));

  function insertar() {
    if (!elegida) return;
    const marca = `[claim:${elegida}]`;
    // El Textarea del kit no reenvía ref: se busca por su id, que es fijo en esta pantalla.
    const area = document.getElementById(AREA_ID) as HTMLTextAreaElement | null;
    const inicio = area?.selectionStart ?? borrador.length;
    const fin = area?.selectionEnd ?? borrador.length;
    setBorrador(`${borrador.slice(0, inicio)}${marca}${borrador.slice(fin)}`);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(inicio + marca.length, inicio + marca.length);
    });
  }

  function guardar() {
    setError(null);
    setEstado(null);
    empezar(async () => {
      // Una petición que falla antes de responder (red, despliegue, tiempo) se dice aquí, no en error.tsx.
      try {
        const r = await guardarNarrativa(borrador, base);
        if (!r.ok) return setError({ message: r.message, detalles: r.detalles });
        setEditando(false);
        setEstado(r.message);
      } catch {
        setError({ message: t.errores.generico, detalles: [] });
      }
    });
  }

  const veredicto = editando && borrador.trim() ? verifyNarrativeWith(borrador, verificador, { paragraphs: null }) : null;

  if (editando) {
    return (
      <div className="space-y-4">
        <Field label={t.campo} help={t.ayuda} htmlFor={AREA_ID}>
          <Textarea
            id={AREA_ID}
            rows={10}
            value={borrador}
            onChange={(e) => setBorrador(e.target.value)}
            invalid={Boolean(error)}
            className="font-mono text-[13px] leading-5"
          />
        </Field>
        <div>
          {/* La ayuda va fuera de la fila: así «Insertar» queda a la altura del control, no del texto de ayuda. */}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t.insertar} htmlFor={CIFRA_ID} className="min-w-0 flex-1">
              <Select id={CIFRA_ID} options={opciones} placeholder={t.insertar} value={elegida} onChange={(e) => setElegida(e.target.value)} />
            </Field>
            <Button onClick={insertar} disabled={!elegida}>{t.insertarBoton}</Button>
          </div>
          <p className="mt-1.5 text-xs text-muted">{t.insertarAyuda}</p>
        </div>
        <section aria-labelledby="narrativa-vista-previa" className="rounded-md border border-line bg-bg-2 p-4">
          <h3 id="narrativa-vista-previa" className="mb-2 text-xs font-medium text-fg-3">{t.vistaPrevia}</h3>
          {borrador.trim() ? (
            <Parrafos texto={borrador} cifras={cifras} prefijo="vista-previa" verificador={verificador} />
          ) : (
            <p className="text-sm text-fg-2">{t.vistaPreviaVacia}</p>
          )}
          {veredicto && (
            <div className="mt-3 border-t border-line pt-3 text-xs">
              {veredicto.ok ? (
                <p className="text-fg-3">{t.vistaPreviaBien}</p>
              ) : (
                <>
                  <p className="font-medium text-bad">{t.vistaPreviaProblemas}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-2">
                    {describirProblemas(veredicto.issues, maxTexto).map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
        {error && (
          <div role="alert" className="rounded-md border border-bad bg-bad-wash px-3 py-2 text-sm text-fg">
            <p className="font-medium">{error.message}</p>
            {error.detalles.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {error.detalles.map((d) => <li key={d}>{d}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={guardar} loading={guardando}>{guardando ? t.guardando : t.guardar}</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setBorrador(texto);
              setError(null);
              setEditando(false);
            }}
          >
            {t.cancelar}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {texto.trim() ? <Parrafos texto={texto} cifras={cifras} prefijo="narrativa" /> : <p className="text-sm text-fg-2">{t.vacia}</p>}
      <p className="mt-4 text-xs text-fg-3">{fuente}</p>
      {aviso && <p className="mt-1 text-xs text-fg-3">{aviso}</p>}
      <p className="mt-1 text-xs text-fg-3">{idioma}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {editable && (
          <Button
            size="sm"
            onClick={() => {
              setBorrador(texto);
              setBase(escritaEl);
              setEstado(null);
              setError(null);
              setEditando(true);
            }}
          >
            {t.editar}
          </Button>
        )}
        <p role="status" className="text-xs text-good">{estado}</p>
      </div>
    </div>
  );
}
