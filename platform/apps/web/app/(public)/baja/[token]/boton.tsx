"use client";

import { useRef, useState, useTransition, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { dejarDeRecibir } from "../actions";
import { MESSAGES } from "../messages";
import { Aviso } from "./aviso";

type Resultado = Awaited<ReturnType<typeof dejarDeRecibir>>;

/**
 * La pregunta y el botón. Después del clic, el resultado reemplaza al
 * botón y recibe el foco, para que un lector de pantalla lo anuncie.
 */
export function DejarDeRecibir({ token }: { token: string }) {
  const t = MESSAGES;
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
          : t.listo
        : resultado.status === "sender"
          ? t.remitente
          : resultado.status === "unavailable"
            ? t.noDisponible
            : t.noExiste;
    return (
      <Aviso ref={avisoRef} tono={resultado.status === "ok" ? "good" : "neutral"} title={texto.title} body={texto.body} />
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.pregunta.title}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">{t.pregunta.body}</p>
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
