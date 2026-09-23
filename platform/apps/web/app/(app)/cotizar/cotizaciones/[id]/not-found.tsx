import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES } from "../../messages";

/**
 * Una cotización que no existe, o que es de otro espacio de trabajo
 * (RLS la esconde igual). Cubre también /editar y /vista, que llaman a
 * `notFound()` dentro de este segmento. Sin este archivo caía en el 404
 * genérico de (app), que ofrece «Volver al plan»; aquí la salida es la
 * lista de cotizaciones, como «Volver a Empresas» en Ventas.
 *
 * La respuesta sale con 404 de verdad (pulido r4): ningún loading.tsx
 * envuelve este segmento, así que el notFound() llega antes del primer
 * byte. Lo prueba app/(app)/no-existe.test.tsx.
 */
export default function CotizacionNoEncontrada() {
  const t = MESSAGES.noEncontrado.cotizacion;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={MESSAGES.cotizaciones.title} />
      <EmptyState title={t.title} description={t.description} action={{ label: t.accion, href: "/cotizar/cotizaciones" }} />
    </>
  );
}
