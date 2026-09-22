import type { Metadata } from "next";
import { ModulePlan } from "@/components/module-plan";

export const metadata: Metadata = { title: "Accesos" };

// Mientras el módulo no tiene pantalla, esta ruta muestra su plan de
// construcción. La pantalla real es ACC-4 (Equipo), en el sprint 5.
export default function Page() {
  return <ModulePlan slug="accesos" />;
}
