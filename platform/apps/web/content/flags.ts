// Banderas de funcionalidad. Un módulo con bandera apagada desaparece de
// la navegación y su ruta responde 404 (ver requireModule en modules.ts).
//
// Las llaves son las de la tabla feature_flag (migración 0009) para que,
// cuando exista el cliente de base (CIM-2), cambiar la fuente sea cambiar
// de dónde se lee y no cómo se llama cada bandera. Las que todavía no
// tienen fila en la base siguen el nombre de su migración y están
// propuestas en docs/propuestas/CIM-4.md.
//
// Los seis módulos del MVP no llevan bandera: siempre están encendidos.
export const FLAG_KEYS = [
  "video_lab", // 0005 · Laboratorio de video (fila en 0009)
  "agency_workspace", // vista agencia (fila en 0009)
  "content_metrics", // 0003 · Mis videos (propuesta)
  "niche_radar", // 0004 · Tendencias del nicho (propuesta)
  "ideas_scripts", // 0006 · Ideas y guiones (propuesta)
  "kit", // galería del kit de interfaz (CIM-5): solo en desarrollo
] as const;

export type FlagKey = (typeof FLAG_KEYS)[number];
export type Flags = Readonly<Record<FlagKey, boolean>>;

export const flags: Flags = {
  // Fase 2: modelados en la base, apagados en el MVP.
  video_lab: false,
  agency_workspace: false,
  content_metrics: false,
  niche_radar: false,
  ideas_scripts: false,
  // Herramientas del equipo: encendidas en desarrollo y apagadas en
  // producción, salvo que el build lleve NEXT_PUBLIC_KIT=1 (vistas previas
  // de Vercel). Tiene que ser NEXT_PUBLIC_: Next solo inyecta esas en el
  // bundle del cliente, y la navegación es un componente cliente; con otra
  // variable el servidor y el navegador verían banderas distintas.
  kit: process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_KIT === "1",
};

export function isFlagKey(key: string): key is FlagKey {
  return (FLAG_KEYS as readonly string[]).includes(key);
}
