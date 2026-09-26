"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { REGENERATE_HINTS, type RegenerateHint } from "@mc/core/outreach/preflight";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Aviso } from "../../_lib/aviso";
import { aprobarToque, regenerarToque, type ResultadoAprobacion } from "./actions";
import { MESSAGES } from "./messages";
import type { FilaVista } from "./vista";

const t = MESSAGES.acciones;

/** Lo que devuelve una acción que no salió: el aviso, con su enlace si lo hay. */
export function Fallo({ r }: { r: Extract<ResultadoAprobacion, { ok: false }> | null }) {
  if (!r?.message) return null;
  return (
    <div className="grid gap-1">
      <Aviso message={r.message} />
      {r.link ? (
        <a href={r.link.href} className="text-sm text-ink underline underline-offset-2">
          {r.link.label}
        </a>
      ) : null}
    </div>
  );
}

/**
 * Las frases del mensaje donde está cada cifra sin origen, con la cifra
 * señalada. Un <textarea> no se puede subrayar por dentro (la API de
 * resaltado que usa el editor del pitch pinta rangos del DOM, y el texto de
 * un textarea no lo es), así que se enseñan debajo, con el mismo subrayado
 * ondulado del color de error, y se actualizan mientras se escribe: la que
 * se corrigió deja de verse.
 */
export function frasesConCifras(texto: string, cifras: readonly string[]): Array<{ antes: string; cifra: string; despues: string }> {
  const out: Array<{ antes: string; cifra: string; despues: string }> = [];
  for (const cifra of cifras) {
    const i = cifra ? texto.indexOf(cifra) : -1;
    if (i < 0) continue;
    const corte = /[.!?\n]/u;
    let a = i;
    while (a > 0 && !corte.test(texto[a - 1]!)) a--;
    let b = i + cifra.length;
    while (b < texto.length && !corte.test(texto[b]!)) b++;
    if (b < texto.length && texto[b] !== "\n") b++;
    out.push({ antes: texto.slice(a, i).trimStart(), cifra, despues: texto.slice(i + cifra.length, b).trimEnd() });
  }
  return out;
}

/**
 * «Editar y aprobar»: el asunto (solo en un correo nuevo) y el mensaje,
 * editables, con el foco en el mensaje. Lo que la base rechaza vuelve en
 * el campo que hay que corregir, también lo que no dejó aprobarlo tal cual
 * (`errorInicial`: «Aprobar» abre aquí el editor con el motivo en su campo,
 * aria-invalid y con el foco); una cifra sin origen se señala en su frase.
 * Al cancelar, el foco vuelve a la fila.
 */
export function EditarYAprobar({
  fila, onDone, onCancel, errorInicial = null,
}: {
  fila: FilaVista;
  onDone: (r: Extract<ResultadoAprobacion, { ok: true }>) => void;
  onCancel: () => void;
  errorInicial?: Extract<ResultadoAprobacion, { ok: false }> | null;
}) {
  const [pending, start] = useTransition();
  const [fallo, setFallo] = useState<Extract<ResultadoAprobacion, { ok: false }> | null>(errorInicial);
  const [cuerpo, setCuerpo] = useState(fila.body);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(), []);
  useEffect(() => {
    if (fallo?.errors) document.querySelector<HTMLElement>(`#editar-${fila.touchId} [aria-invalid="true"]`)?.focus();
  }, [fallo, fila.touchId]);

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    start(async () => {
      const r = await aprobarToque({
        touchId: fila.touchId,
        edicion: { subject: fila.conAsunto ? String(data.get("subject") ?? "") : null, body: String(data.get("body") ?? "") },
      });
      if (r.ok) onDone(r);
      else setFallo(r);
    });
  }

  return (
    <form
      ref={formRef}
      id={`editar-${fila.touchId}`}
      onSubmit={enviar}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="grid gap-3"
    >
      {fila.conAsunto ? (
        <Field label={t.asunto} error={fallo?.errors?.subject}>
          <Input name="subject" defaultValue={fila.subject ?? ""} maxLength={300} />
        </Field>
      ) : null}
      <Field label={t.mensaje} error={fallo?.errors?.body}>
        <Textarea name="body" value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} rows={8} maxLength={20000} />
      </Field>
      <CifrasSenaladas texto={cuerpo} cifras={fallo?.cifras ?? []} />
      <Fallo r={fallo} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.aprobarCambios}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t.cancelar}
        </Button>
      </div>
    </form>
  );
}

function CifrasSenaladas({ texto, cifras }: { texto: string; cifras: readonly string[] }) {
  const frases = frasesConCifras(texto, cifras);
  if (frases.length === 0) return null;
  return (
    <div className="grid gap-1 text-xs">
      <p className="text-ink-2">{t.dondeEsta}</p>
      <ul className="grid gap-1">
        {frases.map((f, i) => (
          <li key={`${f.cifra}-${i}`} className="break-words leading-5 text-ink">
            {f.antes}
            <mark className="rounded-sm bg-bad-wash text-ink underline decoration-bad decoration-wavy underline-offset-2">{f.cifra}</mark>
            {f.despues}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * «Regenerar con una pista»: una de las pistas cerradas del juez y, si
 * se quiere, instrucciones. La versión nueva vuelve a esta bandeja.
 */
export function Regenerar({
  fila, onDone, onCancel,
}: { fila: FilaVista; onDone: (r: Extract<ResultadoAprobacion, { ok: true }>) => void; onCancel: () => void }) {
  const [pending, start] = useTransition();
  const [fallo, setFallo] = useState<Extract<ResultadoAprobacion, { ok: false }> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => formRef.current?.querySelector<HTMLSelectElement>("select")?.focus(), []);

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const hint = String(data.get("hint") ?? "");
    start(async () => {
      const r = await regenerarToque({
        touchId: fila.touchId,
        hint: (REGENERATE_HINTS as readonly string[]).includes(hint) ? (hint as RegenerateHint) : null,
        instructions: String(data.get("instructions") ?? ""),
      });
      if (r.ok) onDone(r);
      else setFallo(r);
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={enviar}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="grid gap-3"
    >
      <Field label={t.pista}>
        <Select name="hint" defaultValue="shorter" options={REGENERATE_HINTS.map((h) => ({ value: h, label: t.pistas[h] }))} />
      </Field>
      <Field label={t.instrucciones} help={t.instruccionesAyuda}>
        <Textarea name="instructions" rows={2} maxLength={500} />
      </Field>
      <Fallo r={fallo} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.pedir}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t.cancelar}
        </Button>
      </div>
    </form>
  );
}
