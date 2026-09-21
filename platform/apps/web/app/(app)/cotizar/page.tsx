import type { Metadata } from "next";
import { ModulePlan } from "@/components/module-plan";

export const metadata: Metadata = { title: "Cotizar" };

// Mientras el módulo no tiene pantalla, esta ruta muestra su plan de
// construcción. El dueño reemplaza este archivo cuando llegue la real.
export default function Page() {
  return <ModulePlan slug="cotizar" />;
}
