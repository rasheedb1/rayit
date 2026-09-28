import type { Metadata } from "next";
import { ModulePlan } from "@/components/module-plan";
import { MODULES } from "@/content/modules";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { MESSAGES } from "./messages";

/**
 * El plan de construcción de cualquier módulo, en una ruta aparte.
 *
 * Mientras un módulo no tiene pantalla, su `page.tsx` muestra el plan
 * directamente. Cuando llega la pantalla real —Resumen es el primero—,
 * el plan no se pierde: se queda aquí, enlazado desde la cabecera del
 * módulo con «Plan de construcción». Así el equipo sigue viendo qué
 * falta sin que el creador se tropiece con el backlog.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return MODULES.filter((m) => m.prefix).map((m) => ({ modulo: m.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ modulo: string }> }): Promise<Metadata> {
  const { modulo } = await params;
  // 404 si el módulo no existe, su bandera está apagada o esta sesión no puede abrirlo (ACC-5).
  return { title: MESSAGES.metaTitle((await requireModuleAccess(modulo)).name) };
}

export default async function PlanPage({ params }: { params: Promise<{ modulo: string }> }) {
  const { modulo } = await params;
  return <ModulePlan slug={modulo} />;
}
