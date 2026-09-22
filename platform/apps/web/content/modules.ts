import { notFound } from "next/navigation";
import type { OwnerId } from "./team";
import { flags as defaultFlags, type FlagKey, type Flags } from "./flags";

export type StoryPrefix = "CIM" | "CON" | "RES" | "VEN" | "COT" | "CAM" | "FIN" | "ACC";

export interface ModuleDef {
  slug: string;
  name: string;
  /** Producto: pantallas que usa el creador. Construcción: lo que ve el equipo. */
  group: "producto" | "construccion";
  phase: 1 | 2;
  /** Dueño del módulo. Cimientos no tiene uno: cada historia lleva el suyo. */
  owner?: OwnerId;
  /** Una frase, en la voz del producto. */
  summary: string;
  /** Qué hace el módulo cuando esté terminado. */
  purpose: string;
  /** Prefijo de sus historias en el backlog. */
  prefix?: StoryPrefix;
  /** Carpetas de las que es dueño quien construye el módulo. */
  paths: string[];
  /** Bandera que lo enciende. Sin bandera, el módulo siempre está encendido. */
  flag?: FlagKey;
}

export const MODULES: readonly ModuleDef[] = [
  {
    slug: "resumen",
    name: "Resumen",
    group: "producto",
    phase: 1,
    owner: "rasheed",
    summary: "Todas tus redes en una sola lectura.",
    purpose:
      "Seguidores, views, alcance en no seguidores y guardados por mil, por red y en el tiempo. Lo que importa esta semana y cuándo publicar. Los datos los trae Conexiones; mientras no hay aprobaciones, se importan por CSV.",
    prefix: "RES",
    paths: ["apps/web/app/(app)/resumen/", "packages/db/src/queries/resumen.ts"],
  },
  {
    slug: "ventas",
    name: "Ventas",
    group: "producto",
    phase: 1,
    owner: "rasheed",
    summary: "Prospectar todos los días y no soltar ningún deal.",
    purpose:
      "Radar de señales, pipeline por etapa con siguiente acción, ficha de empresa con contactos y actividad, y el pitch con cifras trazables.",
    prefix: "VEN",
    paths: ["apps/web/app/(app)/ventas/", "packages/db/src/queries/ventas.ts", "apps/worker/src/jobs/ventas/"],
  },
  {
    slug: "cotizar",
    name: "Cotizar",
    group: "producto",
    phase: 1,
    owner: "rasheed",
    summary: "Cuánto cobrar, con los números que lo sostienen.",
    purpose:
      "Tarifario sugerido por entregable, media kit público y cotización compartible. Al aceptarse, crea la campaña: es la puerta entre Ventas y Campañas.",
    prefix: "COT",
    paths: ["apps/web/app/(app)/cotizar/", "packages/db/src/queries/cotizar.ts", "packages/core/src/tarifas.ts"],
  },
  {
    slug: "campanas",
    name: "Campañas",
    group: "producto",
    phase: 1,
    owner: "nicolas",
    summary: "Lo que cada campaña produjo, listo para enviar.",
    purpose:
      "La campaña, sus posts, los seguidores públicos de la marca, lo que aportó la marca, el resultado contra la mediana propia y el reporte que se envía.",
    prefix: "CAM",
    paths: ["apps/web/app/(app)/campanas/", "packages/db/src/queries/campanas.ts", "apps/worker/src/jobs/campanas/"],
  },
  {
    slug: "finanzas",
    name: "Finanzas",
    group: "producto",
    phase: 1,
    owner: "nicolas",
    summary: "Quién te debe, cuándo entra la plata y cuánto apartar.",
    purpose:
      "Facturas, pagos, cuentas por cobrar con mora, gastos, reserva de impuestos y flujo de caja proyectado a ocho semanas.",
    prefix: "FIN",
    paths: [
      "apps/web/app/(app)/finanzas/",
      "packages/db/src/queries/finanzas.ts",
      "apps/worker/src/jobs/finanzas/",
      "packages/core/src/flujo-caja.ts",
    ],
  },
  {
    slug: "conexiones",
    name: "Conexiones",
    group: "producto",
    phase: 1,
    owner: "nicolas",
    summary: "Las cuentas conectadas y los datos que traen.",
    purpose:
      "Conectar TikTok, Instagram y YouTube, los conectores con sus fixtures, el worker, la recolección diaria de posts y métricas, la línea base del creador y la demografía. Es la entrada de datos de todo el producto.",
    prefix: "CON",
    paths: [
      "apps/web/app/(app)/conexiones/",
      "packages/connectors/",
      "apps/worker/src/runner/",
      "apps/worker/src/jobs/conexiones/",
      "packages/core/src/scoring.ts",
    ],
  },
  {
    slug: "cimientos",
    name: "Cimientos",
    group: "construccion",
    phase: 1,
    summary: "Lo que los dos necesitan antes de la primera pantalla.",
    purpose:
      "Monorepo, cliente de base con aislamiento, autenticación, marco de la aplicación, kit de interfaz, seeds y despliegue continuo.",
    prefix: "CIM",
    paths: ["packages/db/src/client.ts (Rasheed)", "apps/web/components/ui/ (Nicolás)", "db/seed/ (por archivo)"],
  },
  {
    slug: "accesos",
    name: "Accesos",
    group: "construccion",
    phase: 1,
    summary: "Una cuenta, varias personas, y cada una con lo suyo.",
    purpose:
      "Roles y permisos dentro de un workspace: el creador invita a su mánager, a su editor o a su contador y cada uno ve solo lo que le toca. El código pregunta por permisos, nunca por roles; el dinero no entra en ningún rol por defecto; y toda escritura de dinero o de cuenta conectada deja rastro en audit_log. Entró al MVP el 22 de septiembre, al confirmarse que los creadores del piloto tienen mánager. El alcance por creador y las agencias son la fase 2.",
    prefix: "ACC",
    paths: [
      "packages/core/src/permisos.ts (Nicolás)",
      "apps/web/lib/auth/ (Rasheed)",
      "packages/db/src/scope.ts, audit.ts (Rasheed)",
      "db/migrations/0017_access_control.sql (propone Nicolás, aplica Rasheed)",
    ],
  },
  // Fase 2. Apagados en flags.ts; la base ya los modela.
  { slug: "videos", name: "Mis videos", group: "producto", phase: 2, summary: "Qué de lo tuyo funciona y por qué.", purpose: "", paths: [], flag: "content_metrics" },
  { slug: "nicho", name: "Tendencias del nicho", group: "producto", phase: 2, summary: "Lo que está rompiendo en tu nicho esta semana.", purpose: "", paths: [], flag: "niche_radar" },
  { slug: "ideas", name: "Ideas y guiones", group: "producto", phase: 2, summary: "Tres ideas para esta semana, con guion listo.", purpose: "", paths: [], flag: "ideas_scripts" },
  { slug: "laboratorio", name: "Laboratorio de video", group: "producto", phase: 2, summary: "Sube el máster y recibe el semáforo por red.", purpose: "", paths: [], flag: "video_lab" },
  { slug: "agencia", name: "Vista agencia", group: "producto", phase: 2, summary: "Varias marcas, un solo tablero. La agencia no absorbe al creador: recibe una concesión revocable sobre su workspace (épico AGE).", purpose: "", paths: [], flag: "agency_workspace" },
  // Herramientas del equipo: no van en la navegación de producto.
  { slug: "kit", name: "Kit de interfaz", group: "construccion", phase: 1, owner: "nicolas", summary: "Los componentes compartidos, con datos de ejemplo.", purpose: "Galería de CIM-5: cada componente en claro y oscuro, vacío, cargando y con valores largos.", paths: ["apps/web/components/ui/"], flag: "kit" },
];

export function moduleBySlug(slug: string): ModuleDef | undefined {
  return MODULES.find((m) => m.slug === slug);
}

export function moduleByPrefix(prefix: StoryPrefix): ModuleDef {
  const m = MODULES.find((x) => x.prefix === prefix);
  if (!m) throw new Error(`No hay módulo para el prefijo ${prefix}`);
  return m;
}

/** Un módulo sin bandera siempre está encendido. `flags` se inyecta en pruebas. */
export function isEnabled(m: ModuleDef, flags: Flags = defaultFlags): boolean {
  return m.flag === undefined || flags[m.flag] === true;
}

/** Módulos de producto encendidos, en el orden de la navegación. */
export function productModules(flags: Flags = defaultFlags): ModuleDef[] {
  return MODULES.filter((m) => m.group === "producto" && isEnabled(m, flags));
}

export const PRODUCT_MODULES = productModules();
export const PHASE2_MODULES = MODULES.filter((m) => m.phase === 2);

/**
 * El módulo de una ruta, o 404 si no existe o su bandera está apagada.
 * Lo llama la página de cada módulo (hoy, ModulePlan) antes de renderizar:
 * apagar una bandera cierra la ruta directa, no solo la quita del menú.
 */
export function requireModule(slug: string, flags: Flags = defaultFlags): ModuleDef {
  const m = moduleBySlug(slug);
  if (!m || !isEnabled(m, flags)) notFound();
  return m;
}
