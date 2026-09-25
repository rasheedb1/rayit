"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { dejarDeRecibir } from "../actions";
import { bajaTexts, type BajaIdioma } from "../messages";
import { Aviso } from "./aviso";

type Resultado = Awaited<ReturnType<typeof dejarDeRecibir>>;

/**
 * La pregunta y el botón. Dice para qué dirección es (enmascarada) y de
 * quién, como la baja de Substack. Después del clic, el resultado
 * reemplaza al botón y recibe el foco, para que un lector de pantalla lo
 * anuncie.
 */
export function DejarDeRecibir({
  token,
  direccion,
  quien,
  idioma,
  soporte,
}: {
  token: string;
  direccion: string;
  quien: string | null;
  /** SUPPORT_EMAIL, para deshacer una baja por error; null si no está configurado. */
  soporte: string | null;
  /** El de la página: el del espacio que envió el correo (r5). */
  idioma: BajaIdioma;
}) {
  const t = bajaTexts(idioma);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [pending, startTransition] = useTransition();
  const avisoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (resultado && resultado.status !== "error") avisoRef.current?.focus();
  }, [resultado]);

  if (resultado && resultado.status !== "error") {
    const texto =
      resultado.status === "ok"
        ? resultado.alreadyOptedOut
          ? t.yaEstaba
          : { title: t.listo.title(quien), body: t.listo.body(soporte) }
        : resultado.status === "sender"
          ? t.remitente
          : t.noExiste;
    return (
      <Aviso ref={avisoRef} tono={resultado.status === "ok" ? "good" : "neutral"} title={texto.title} body={texto.body} />
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.pregunta.title}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink">{t.pregunta.frase(quien, direccion)}</p>
      {resultado?.status === "error" && (
        <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {t.error}
        </p>
      )}
      <div className="mt-6">
        <Button
          variant="primary"
          loading={pending}
          onClick={() => startTransition(async () => setResultado(await dejarDeRecibir(token)))}
        >
          {pending ? t.pregunta.enviando : t.pregunta.boton}
        </Button>
      </div>
    </div>
  );
}
