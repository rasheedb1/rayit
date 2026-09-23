"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import type { VentasState } from "../actions";

/**
 * El formulario de Ventas con su Server Action.
 *
 * Se envía con `onSubmit` y no con `action={…}` a propósito: React 19
 * vacía un formulario no controlado al terminar su acción, también
 * cuando vuelve con errores, y la persona perdería lo que escribió por
 * una tilde de más en el país. Aquí se vacía solo cuando sale bien
 * (cambia `stamp`), y el foco va al primer campo con error cuando no.
 */
export function useVentasForm(
  action: (prev: VentasState, formData: FormData) => Promise<VentasState>,
  onSuccess?: (state: VentasState) => void,
) {
  const [state, dispatch, pending] = useActionState<VentasState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const successRef = useRef(onSuccess);
  successRef.current = onSuccess;

  useEffect(() => {
    if (state.errors) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  useEffect(() => {
    if (!state.stamp) return;
    formRef.current?.reset();
    successRef.current?.(state);
  }, [state.stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  }

  /**
   * Reenviar el formulario con algún campo de más, sin que la persona
   * lo escriba: «Crear igual» manda lo mismo con `sameName=1`.
   */
  function resubmit(extra: Record<string, string>) {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    for (const [k, v] of Object.entries(extra)) data.set(k, v);
    startTransition(() => dispatch(data));
  }

  return { state, pending, formRef, onSubmit, resubmit, errors: state.errors ?? {} };
}
