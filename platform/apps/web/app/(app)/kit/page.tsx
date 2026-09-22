import type { Metadata } from "next";
import { requireModule } from "@/content/modules";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Kit de interfaz" };

// Galería del kit (CIM-5). Detrás de la bandera "kit": encendida en
// desarrollo, apagada en producción, donde esta ruta responde 404.
export default function Page() {
  const mod = requireModule("kit");
  return <PageHeader eyebrow="Construcción" title={mod.name} description="La galería llega con CIM-5." />;
}
