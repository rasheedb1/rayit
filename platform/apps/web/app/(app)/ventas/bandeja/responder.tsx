"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Aviso } from "../../_lib/aviso";
import { crearReferido, marcarLeido, responder, type ResultadoBandeja } from "./actions";
import { MESSAGES } from "./messages";

const t = MESSAGES;

/** Un id nuevo para el próximo envío: el mismo formulario enviado dos veces es UN mensaje. */
function nuevoId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Al abrir un hilo con mensajes sin leer, se marcan leídos (y la lista
 * se refresca para quitarles la negrita). No pinta nada.
 */
export function MarcarLeido({ contactId, channel, sinLeer }: { contactId: string; channel: string; sinLeer: number }) {
  const router = useRouter();
  useEffect(() => {
    if (sinLeer === 0) return;
    void marcarLeido({ contactId, channel }).then(() => router.refresh());
  }, [contactId, channel, sinLeer, router]);
  return null;
}

/**
 * «Tu respuesta»: sale por el motor (la cuenta y el hilo del mensaje, el
 * pie de baja en un correo), no desde el navegador. Al salir bien, el
 * campo se vacía, el aviso lo dice y el próximo envío lleva otro id.
 */
export function Responder({ contactId, channel, ayuda }: { contactId: string; channel: string; ayuda: string }) {
  const [touchId, setTouchId] = useState(nuevoId);
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = String(new FormData(e.currentTarget).get("body") ?? "");
    start(async () => {
      const r = await responder({ touchId, contactId, channel, body });
      setResultado(r);
      if (r.ok) {
        formRef.current?.reset();
        setTouchId(nuevoId());
      } else if (r.field) {
        formRef.current?.querySelector<HTMLElement>("textarea")?.focus();
      }
    });
  }

  const error = resultado && !resultado.ok ? resultado : null;
  return (
    <form ref={formRef} onSubmit={enviar} className="grid gap-3">
      <Field label={t.responder.label} help={ayuda} error={error?.field ? error.error : undefined}>
        <Textarea name="body" rows={4} maxLength={5000} placeholder={t.responder.placeholder} />
      </Field>
      <Aviso message={error && !error.field ? error.error : null} notice={resultado?.ok ? resultado.notice : null} />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t.responder.enviar}
        </Button>
      </div>
    </form>
  );
}

/**
 * «Crear contacto» desde un referido: el nombre, el correo y el cargo que
 * leyó el clasificador, editables. Nada se crea sin que una persona lo pida.
 */
export function CrearReferido({
  messageId, nombre, correo, cargo,
}: { messageId: string; nombre: string | null; correo: string | null; cargo: string | null }) {
  const [abierto, setAbierto] = useState(false);
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (abierto) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [abierto]);

  if (resultado?.ok) return <Aviso notice={resultado.notice} size="xs" />;
  if (!abierto) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setAbierto(true)}>
        {t.referido.crear}
      </Button>
    );
  }
  const error = resultado && !resultado.ok ? resultado : null;
  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    start(async () => {
      setResultado(
        await crearReferido({
          messageId, fullName: String(d.get("fullName") ?? ""), email: String(d.get("email") ?? ""), roleTitle: String(d.get("roleTitle") ?? ""),
        }),
      );
    });
  }
  return (
    <form ref={formRef} onSubmit={enviar} className="grid gap-3 rounded-md border border-border bg-surface p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t.referido.nombre} error={error?.field === "fullName" ? error.error : undefined}>
          <Input name="fullName" defaultValue={nombre ?? ""} maxLength={200} />
        </Field>
        <Field label={t.referido.correo} error={error?.field === "email" ? error.error : undefined}>
          <Input name="email" type="email" defaultValue={correo ?? ""} maxLength={254} />
        </Field>
        <Field label={t.referido.cargo}>
          <Input name="roleTitle" defaultValue={cargo ?? ""} maxLength={200} />
        </Field>
      </div>
      <Aviso message={error && !error.field ? error.error : null} size="xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t.referido.guardar}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>
          {t.referido.cancelar}
        </Button>
      </div>
    </form>
  );
}
