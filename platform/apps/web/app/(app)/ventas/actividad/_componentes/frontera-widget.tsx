"use client";

import { Component, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "../messages";

interface Props {
  /** Qué no se pudo cargar, en una frase: el resto de la pantalla sigue. */
  aviso: string;
  children: ReactNode;
}

class Frontera extends Component<Props & { onRetry: (reset: () => void) => void; pendiente: boolean }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // En producción solo llega el digest; el servidor ya lo registró con su traza.
    console.error("[ventas/actividad] una pieza montada falló al cargar", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3">
        <p className="text-sm text-fg-2">{this.props.aviso}</p>
        <Button
          size="sm"
          variant="secondary"
          loading={this.props.pendiente}
          onClick={() => this.props.onRetry(() => this.setState({ error: null }))}
        >
          {MESSAGES.widget.reintentar}
        </Button>
      </div>
    );
  }
}

/**
 * La frontera de error propia de una pieza de la actividad montada en otra
 * pantalla (el uso por canal en /ventas/canales, el embudo en
 * /ventas/cadencias/[id]). Si su consulta falla —por ejemplo, en el hueco
 * entre desplegar y que el integrador aplique la migración de las vistas
 * en Supabase— cae solo la pieza, con un aviso y «Volver a intentar», y la
 * pantalla anfitriona sigue entera. Sin esto, el error subía al error.tsx
 * del segmento y se llevaba la pantalla completa.
 *
 * «Volver a intentar» pide la página otra vez al servidor (router.refresh)
 * y después vuelve a montar lo de dentro.
 */
export function FronteraWidget({ aviso, children }: Props) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const onRetry = (reset: () => void) =>
    empezar(() => {
      router.refresh();
      reset();
    });
  return (
    <Frontera aviso={aviso} onRetry={onRetry} pendiente={pendiente}>
      {children}
    </Frontera>
  );
}
