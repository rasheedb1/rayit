"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { Casilla } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Select } from "@/components/ui/field";
import type { ActionState } from "@/lib/forms";
import { formatDate, type LocaleOpts } from "@/lib/format";
import { MESSAGES } from "./_lib/messages";
import { cambiarRol, invitar, quitarMiembro, renovarInvitacion, type InvitarState } from "./actions";

const t = MESSAGES;

/** Un rol que esta persona puede dar, ya filtrado en el servidor. */
export interface RolOpcion {
  id: string;
  label: string;
  description: string | null;
  /** Si admite las casillas del mánager (solo el Mánager de creador). */
  conCasillas: boolean;
}

/** Una casilla, y si quien mira la puede dar (nadie otorga lo que no tiene). */
export interface CasillaOpcion {
  casilla: Casilla;
  disponible: boolean;
}

/** Cuánto dura el «Copiado» antes de volver al texto del botón. */
const COPIADO_MS = 2000;

/** Las casillas del mánager: APAGADAS por defecto, y deshabilitadas si quien invita no tiene lo que dan. */
function Casillas({ opciones, marcadas }: { opciones: CasillaOpcion[]; marcadas?: readonly Casilla[] }) {
  return (
    <fieldset className="grid gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium text-muted">{t.invitar.casillasTitulo}</legend>
      {opciones.map(({ casilla, disponible }) => (
        <Checkbox
          key={casilla}
          name={`casilla.${casilla}`}
          label={t.casillas[casilla].label}
          help={disponible ? t.casillas[casilla].ayuda : `${t.casillas[casilla].ayuda} ${t.casillaNoDisponible}`}
          defaultChecked={marcadas?.includes(casilla) ?? false}
          disabled={!disponible}
        />
      ))}
    </fieldset>
  );
}

/**
 * El enlace recién creado, para copiarlo, y qué pasó con el correo. Solo
 * se ve en la respuesta de la acción: la base guarda el hash y el enlace
 * no se puede volver a pintar.
 */
export function ResultadoInvitacion({ estado, fechas }: { estado: NonNullable<InvitarState["invitacion"]>; fechas: LocaleOpts }) {
  const [copia, setCopia] = useState<"quieto" | "copiado" | "fallo">("quieto");
  const id = useId();
  const r = t.resultado;

  useEffect(() => {
    if (copia === "quieto") return;
    const timer = setTimeout(() => setCopia("quieto"), COPIADO_MS);
    return () => clearTimeout(timer);
  }, [copia]);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(estado.enlace);
      setCopia("copiado");
    } catch {
      setCopia("fallo");
    }
  }

  const correo = estado.envio === "enviado" ? r.enviada : estado.envio === "fallo" ? r.falloCorreo : r.sinCorreo;
  return (
    <div role="status" className="grid gap-3 rounded-md border border-border bg-surface-2 p-4 text-sm">
      <p className="font-medium text-ink">{r.titulo(estado.correo)}</p>
      <p className={estado.envio === "enviado" ? "text-ink-2" : "text-warn"}>{correo}</p>
      {estado.reemplazadas > 0 && <p className="text-muted">{r.reemplazada}</p>}
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-enlace`} className="text-xs font-medium text-muted">
          {r.enlace}
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id={`${id}-enlace`}
            readOnly
            value={estado.enlace}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button size="sm" variant="secondary" onClick={copiar}>
            {copia === "copiado" ? r.copiado : r.copiar}
          </Button>
        </div>
        <span aria-live="polite" className="text-xs text-muted">
          {copia === "copiado" && r.copiadoAviso}
          {copia === "fallo" && r.copiarFallo}
        </span>
      </div>
      <p className="text-xs text-muted">
        {r.vence(formatDate(estado.venceIso, "long", fechas))} {r.soloAhora}
      </p>
    </div>
  );
}

/**
 * Invitar por correo. El rol se elige entre los que quien invita puede
 * dar; si es Mánager de creador aparecen las dos casillas, apagadas.
 */
export function InvitarForm({
  roles,
  casillas,
  fechas,
}: {
  roles: RolOpcion[];
  casillas: CasillaOpcion[];
  /** El locale y la zona del workspace, para la fecha de vencimiento. */
  fechas: LocaleOpts;
}) {
  const [estado, accion, enviando] = useActionState<InvitarState, FormData>(invitar, {});
  const [roleId, setRoleId] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const rol = roles.find((r) => r.id === roleId);

  useEffect(() => {
    if (estado.ok) {
      formRef.current?.reset();
      setRoleId("");
    }
  }, [estado]);

  return (
    <div className="grid gap-4">
      <form ref={formRef} action={accion} className="grid gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.invitar.correo} help={t.invitar.correoAyuda} error={estado.errors?.email} required>
            <Input name="email" type="email" autoComplete="off" maxLength={254} />
          </Field>
          <Field label={t.invitar.rol} help={rol?.description ?? undefined} error={estado.errors?.roleId} required>
            <Select
              name="roleId"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              placeholder={t.invitar.rolPlaceholder}
              options={roles.map((r) => ({ value: r.id, label: r.label }))}
            />
          </Field>
        </div>
        {rol?.conCasillas && <Casillas key={roleId} opciones={casillas} />}
        {estado.message && (
          <p role="alert" className="text-sm text-bad">
            {estado.message}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" loading={enviando}>
            {t.invitar.enviar}
          </Button>
        </div>
      </form>
      {estado.invitacion && <ResultadoInvitacion estado={estado.invitacion} fechas={fechas} />}
    </div>
  );
}

/**
 * «Cambiar rol» de una persona, en su misma fila: un botón que abre el
 * selector de rol y, si es Mánager de creador, sus casillas con lo que
 * tiene hoy marcado.
 */
export function CambiarRol({
  userId,
  roleId,
  marcadas,
  roles,
  casillas,
}: {
  userId: string;
  roleId: string;
  marcadas: readonly Casilla[];
  roles: RolOpcion[];
  casillas: CasillaOpcion[];
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion, enviando] = useActionState<ActionState, FormData>(cambiarRol, {});
  const [elegido, setElegido] = useState(roleId);
  const rol = roles.find((r) => r.id === elegido);

  useEffect(() => {
    if (estado.ok) setAbierto(false);
  }, [estado]);

  if (!abierto) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <Button size="sm" variant="ghost" onClick={() => setAbierto(true)}>
          {t.miembros.cambiarRol}
        </Button>
        {estado.ok && (
          <span role="status" className="text-xs text-good">
            {t.miembros.guardado}
          </span>
        )}
      </span>
    );
  }

  return (
    <form action={accion} className="grid w-full gap-3 rounded-md border border-border bg-surface-2 p-3">
      <input type="hidden" name="userId" value={userId} />
      <Field label={t.invitar.rol} help={rol?.description ?? undefined} error={estado.errors?.roleId}>
        <Select name="roleId" value={elegido} onChange={(e) => setElegido(e.target.value)} options={roles.map((r) => ({ value: r.id, label: r.label }))} />
      </Field>
      {rol?.conCasillas && <Casillas key={elegido} opciones={casillas} marcadas={elegido === roleId ? marcadas : []} />}
      {estado.message && (
        <p role="alert" className="text-sm text-bad">
          {estado.message}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>
          {t.miembros.cancelar}
        </Button>
        <Button size="sm" type="submit" variant="primary" loading={enviando}>
          {t.miembros.guardar}
        </Button>
      </div>
    </form>
  );
}

/**
 * «Quitar» a una persona, en dos pasos y en el mismo sitio (el patrón de
 * ConfirmInline del kit). Va aparte porque aquí la acción puede
 * responder con una frase —«no se puede quitar al último dueño»— y
 * ConfirmInline solo sabe de acciones que no devuelven nada.
 */
export function QuitarMiembro({ userId, quien }: { userId: string; quien: string }) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion, enviando] = useActionState<ActionState, FormData>(quitarMiembro, {});
  const id = useId();
  const preguntaRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (abierto) preguntaRef.current?.focus();
  }, [abierto]);

  if (!abierto) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <Button size="sm" variant="danger" onClick={() => setAbierto(true)}>
          {t.miembros.quitar}
        </Button>
        {estado.message && (
          <span role="alert" className="max-w-xs text-xs text-bad">
            {estado.message}
          </span>
        )}
      </span>
    );
  }

  return (
    <form
      action={(fd) => {
        setAbierto(false);
        accion(fd);
      }}
      role="group"
      aria-labelledby={`${id}-pregunta`}
      aria-describedby={`${id}-consecuencia`}
      className="grid w-full gap-2 rounded-md border border-border bg-surface-2 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") setAbierto(false);
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <p id={`${id}-pregunta`} ref={preguntaRef} tabIndex={-1} className="text-sm font-medium text-ink outline-none">
        {t.miembros.quitarPregunta(quien)}
      </p>
      <p id={`${id}-consecuencia`} className="text-xs text-muted">
        {t.miembros.quitarConsecuencia}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>
          {t.miembros.cancelar}
        </Button>
        <Button size="sm" type="submit" variant="danger" loading={enviando}>
          {t.miembros.quitarConfirmar}
        </Button>
      </div>
    </form>
  );
}

/** «Nuevo enlace» para una invitación pendiente: revoca la anterior y enseña el enlace nuevo. */
export function RenovarInvitacion({ invitationId, fechas }: { invitationId: string; fechas: LocaleOpts }) {
  const [estado, accion, enviando] = useActionState<InvitarState, FormData>(renovarInvitacion, {});
  return (
    <div className="grid w-full gap-2">
      <form action={accion}>
        <input type="hidden" name="invitationId" value={invitationId} />
        <Button size="sm" type="submit" variant="secondary" loading={enviando}>
          {t.pendientes.renovar}
        </Button>
      </form>
      {estado.message && (
        <p role="alert" className="text-xs text-bad">
          {estado.message}
        </p>
      )}
      {estado.invitacion && <ResultadoInvitacion estado={estado.invitacion} fechas={fechas} />}
    </div>
  );
}
