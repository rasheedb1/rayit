"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Casilla } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Field, Input, Select } from "@/components/ui/field";
import type { ActionState } from "@/lib/forms";
import { formatDate, type LocaleOpts } from "@/lib/format";
import { MESSAGES } from "./_lib/messages";
import { cambiarRol, invitar, quitarMiembro, renovarInvitacion, revocarInvitacion, type InvitarState } from "./actions";

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

  const correo = { enviado: r.enviada, fallo: r.falloCorreo, sin_configurar: r.sinCorreo, demo: r.demo }[estado.envio];
  // Solo es un aviso cuando falta algo que debería estar (SMTP, o el
  // servidor falló); en la demo no enviar es lo esperado.
  const aviso = estado.envio === "fallo" || estado.envio === "sin_configurar";
  return (
    <div role="status" className="grid gap-3 rounded-md border border-border bg-surface-2 p-4 text-sm">
      <p className="font-medium text-ink">{r.titulo(estado.correo)}</p>
      <p className={aviso ? "text-warn" : "text-ink-2"}>{correo}</p>
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
 * Envía un formulario a su acción SIN el reinicio que React 19 hace a
 * un `<form action>` al terminar: ese reinicio vacía el correo y las
 * casillas aunque la acción responda con un error, y deja el <select>
 * controlado diciendo otra cosa que su estado. Con onSubmit, lo
 * escrito se queda; cada formulario se vacía a mano solo cuando sale
 * bien.
 */
function enviarSinReiniciar(accion: (fd: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => accion(fd));
  };
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
  const mensajeRef = useRef<HTMLParagraphElement>(null);
  const resultadoRef = useRef<HTMLDivElement>(null);
  const rol = roles.find((r) => r.id === roleId);
  /**
   * Los campos que se corrigieron después del último envío: su error de
   * ese envío ya no dice la verdad y se apaga en cuanto se tocan. El
   * servidor vuelve a validar en el siguiente envío.
   */
  const [corregidos, setCorregidos] = useState<ReadonlySet<"email" | "roleId">>(new Set());
  const corregir = (campo: "email" | "roleId") =>
    setCorregidos((antes) => (antes.has(campo) ? antes : new Set(antes).add(campo)));
  const errorDe = (campo: "email" | "roleId") => (corregidos.has(campo) ? undefined : estado.errors?.[campo]);

  // Cada respuesta trae sus propios errores. Solo cuando sale bien se
  // vacía el formulario: con un error, lo escrito se queda.
  //
  // Y el foco: mientras la acción corre, «Invitar» está en carga y
  // deshabilitado, así que lo pierde. Al volver se lleva a lo que hay que
  // leer o corregir —el primer campo con error, el mensaje general, o el
  // enlace recién creado (que se selecciona solo, listo para copiar)—
  // para que quien usa teclado o lector de pantalla no vuelva a empezar
  // desde arriba. El campo se busca por su nombre y no por aria-invalid:
  // en este render todavía puede llevar la marca de «corregido».
  useEffect(() => {
    setCorregidos(new Set());
    if (estado.ok) {
      formRef.current?.reset();
      setRoleId("");
      resultadoRef.current?.querySelector<HTMLInputElement>("input[readonly]")?.focus();
      return;
    }
    const campo = (["email", "roleId"] as const).find((c) => estado.errors?.[c]);
    if (campo) formRef.current?.querySelector<HTMLElement>(`[name="${campo}"]`)?.focus();
    else if (estado.message) mensajeRef.current?.focus();
  }, [estado]);

  return (
    <div className="grid gap-4">
      <form ref={formRef} onSubmit={enviarSinReiniciar(accion)} className="grid gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.invitar.correo} help={t.invitar.correoAyuda} error={errorDe("email")} required>
            <Input name="email" type="email" autoComplete="off" maxLength={254} onChange={() => corregir("email")} />
          </Field>
          <Field label={t.invitar.rol} help={rol?.description ?? undefined} error={errorDe("roleId")} required>
            <Select
              name="roleId"
              value={roleId}
              onChange={(e) => {
                setRoleId(e.target.value);
                corregir("roleId");
              }}
              placeholder={t.invitar.rolPlaceholder}
              options={roles.map((r) => ({ value: r.id, label: r.label }))}
            />
          </Field>
        </div>
        {rol?.conCasillas && <Casillas key={roleId} opciones={casillas} />}
        {estado.message && (
          <p ref={mensajeRef} role="alert" tabIndex={-1} className="text-sm text-bad focus:outline-none">
            {estado.message}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" loading={enviando}>
            {t.invitar.enviar}
          </Button>
        </div>
      </form>
      {/* contents: sin caja propia, para no sumar un hueco de la rejilla cuando está vacío. */}
      <div ref={resultadoRef} className="contents">
        {estado.invitacion && <ResultadoInvitacion estado={estado.invitacion} fechas={fechas} />}
      </div>
    </div>
  );
}

/**
 * «Cambiar rol» de una persona, en su misma fila: un botón que abre el
 * selector de rol y, si es Mánager de creador, sus casillas con lo que
 * tiene hoy marcado. Como ConfirmAction: al abrir, el foco va al
 * selector; Escape o Cancelar cierran y lo devuelven al botón; al
 * guardar, el formulario se queda abierto con el botón en carga y se
 * cierra cuando la acción sale bien. Si vuelve con un error («no se
 * puede degradar al último dueño»), sigue abierto y el foco va al error.
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
  const selectorRef = useRef<HTMLDivElement>(null);
  const disparadorRef = useRef<HTMLSpanElement>(null);
  const alertaRef = useRef<HTMLParagraphElement>(null);
  const volverAlDisparador = useRef(false);
  const estadoVisto = useRef(estado);
  // El estado que había al abrir: su mensaje es de un intento anterior y no se repite.
  const [estadoAlAbrir, setEstadoAlAbrir] = useState<ActionState | null>(null);

  // La acción salió bien: se cierra y el foco vuelve al botón. Con un
  // error, el formulario sigue abierto y el foco va al mensaje.
  useEffect(() => {
    if (estado === estadoVisto.current) return;
    estadoVisto.current = estado;
    if (estado.ok) {
      volverAlDisparador.current = true;
      setAbierto(false);
    } else if (estado.message) {
      alertaRef.current?.focus();
    }
  }, [estado]);

  useEffect(() => {
    if (abierto) {
      selectorRef.current?.querySelector("select")?.focus();
    } else if (volverAlDisparador.current) {
      volverAlDisparador.current = false;
      disparadorRef.current?.querySelector("button")?.focus();
    }
  }, [abierto]);

  function cerrar() {
    volverAlDisparador.current = true;
    setAbierto(false);
    setElegido(roleId);
  }

  if (!abierto) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <span ref={disparadorRef} className="inline-flex">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEstadoAlAbrir(estado);
              setAbierto(true);
            }}
            className="whitespace-nowrap"
          >
            {t.miembros.cambiarRol}
          </Button>
        </span>
        {estado.ok && (
          <span role="status" className="text-xs text-good">
            {t.miembros.guardado}
          </span>
        )}
      </span>
    );
  }

  return (
    <form
      onSubmit={enviarSinReiniciar(accion)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !enviando) {
          e.preventDefault();
          cerrar();
        }
      }}
      aria-busy={enviando || undefined}
      className="grid w-full gap-3 rounded-md border border-border bg-surface-2 p-3"
    >
      <input type="hidden" name="userId" value={userId} />
      <div ref={selectorRef}>
        <Field label={t.invitar.rol} help={rol?.description ?? undefined} error={estado.errors?.roleId}>
          <Select name="roleId" value={elegido} onChange={(e) => setElegido(e.target.value)} options={roles.map((r) => ({ value: r.id, label: r.label }))} />
        </Field>
      </div>
      {rol?.conCasillas && <Casillas key={elegido} opciones={casillas} marcadas={elegido === roleId ? marcadas : []} />}
      {estado.message && estado !== estadoAlAbrir && (
        <p ref={alertaRef} role="alert" tabIndex={-1} className="text-sm text-bad focus:outline-none">
          {estado.message}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cerrar} disabled={enviando}>
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
 * «Quitar» a una persona, en dos pasos y en el mismo sitio, con
 * ConfirmAction del kit: la acción puede responder con una frase —«no se
 * puede quitar al último dueño»— y esa frase queda bajo el botón. Si la
 * persona es la única dueña, el botón ni se ofrece: sale deshabilitado
 * con una nota corta y neutra (miembros.unicoDueno); la frase del error
 * (errores.last_owner) queda para cuando la acción falla de verdad. La
 * acción y el disparador de la base siguen siendo la barrera real.
 *
 * Si sale bien, la fila desaparece con el botón: el foco y el aviso los
 * pone AvisoDeSalidas (salidas.tsx), que vive por encima de la lista.
 */
export function QuitarMiembro({ userId, quien, unicoDueno = false }: { userId: string; quien: string; unicoDueno?: boolean }) {
  return (
    <ConfirmAction
      action={quitarMiembro}
      fields={{ userId }}
      label={t.miembros.quitar}
      variant="danger"
      size="sm"
      question={t.miembros.quitarPregunta(quien)}
      consequence={t.miembros.quitarConsecuencia}
      confirmLabel={t.miembros.quitarConfirmar}
      cancelLabel={t.miembros.cancelar}
      disabledReason={unicoDueno ? t.miembros.unicoDueno : undefined}
    />
  );
}

/**
 * Lo que se puede hacer con una invitación pendiente: «Nuevo enlace» y
 * «Revocar», los dos del mismo tamaño en una fila que envuelve, y debajo,
 * en su propia fila, el enlace nuevo o el motivo por el que no se pudo.
 */
export function AccionesInvitacion({ invitationId, correo, fechas }: { invitationId: string; correo: string; fechas: LocaleOpts }) {
  const [estado, accion, enviando] = useActionState<InvitarState, FormData>(renovarInvitacion, {});
  const resultadoRef = useRef<HTMLDivElement>(null);
  const mensajeRef = useRef<HTMLParagraphElement>(null);
  const estadoVisto = useRef(estado);

  // El foco, como en InvitarForm: mientras corre, «Nuevo enlace» está en
  // carga y deshabilitado y lo pierde. Al volver va al enlace nuevo (que
  // se selecciona solo, listo para copiar) o al motivo por el que no se
  // pudo; nunca se queda en <body>. Si revocar hace desaparecer la fila,
  // el foco lo pone AvisoDeSalidas.
  useEffect(() => {
    if (estado === estadoVisto.current) return;
    estadoVisto.current = estado;
    if (estado.invitacion) resultadoRef.current?.querySelector<HTMLInputElement>("input[readonly]")?.focus();
    else if (estado.message) mensajeRef.current?.focus();
  }, [estado]);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <form onSubmit={enviarSinReiniciar(accion)} className="shrink-0">
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button size="sm" type="submit" variant="secondary" loading={enviando} className="whitespace-nowrap">
            {t.pendientes.renovar}
          </Button>
        </form>
        <ConfirmAction
          action={revocarInvitacion}
          fields={{ invitationId }}
          label={t.pendientes.revocar}
          variant="danger"
          size="sm"
          question={t.pendientes.revocarPregunta(correo)}
          consequence={t.pendientes.revocarConsecuencia}
          confirmLabel={t.pendientes.revocarConfirmar}
          cancelLabel={t.pendientes.cancelar}
          openWidth="w-full sm:w-80"
        />
      </div>
      {estado.message && (
        <p ref={mensajeRef} role="alert" tabIndex={-1} className="text-xs text-bad focus:outline-none">
          {estado.message}
        </p>
      )}
      {/* contents: sin caja propia, como en InvitarForm. */}
      <div ref={resultadoRef} className="contents">
        {estado.invitacion && <ResultadoInvitacion estado={estado.invitacion} fechas={fechas} />}
      </div>
    </div>
  );
}
