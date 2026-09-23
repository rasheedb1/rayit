import { notFound } from "next/navigation";
import type { OwnerId } from "./team";
import { flags as defaultFlags, isFlagKey, type FlagKey, type Flags } from "./flags";

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
  /**
   * Permiso mínimo para abrirlo (ACC-5): el `.ver` principal del módulo.
   * Una bandera dice si el módulo EXISTE; un permiso, si ESTA persona
   * entra; se evalúan en ese orden (requireModule). Sin permiso, el
   * módulo se abre a cualquier sesión, como sin bandera siempre está
   * encendido: hoy solo las herramientas del equipo (cimientos, kit) y
   * los de fase 2, que están apagados y reciben el suyo al encenderse.
   */
  permission?: ModulePermission;
}

/**
 * Los permisos mínimos por módulo, con los nombres del catálogo de
 * ACC-1 (`PERMISO_MINIMO` de @mc/core). Cuando ACC-1 esté en main este
 * tipo pasa a ser `Permiso` de core y esta lista se borra: si un
 * nombre difiere, `permission` deja de compilar y es una línea.
 */
export const MODULE_PERMISSIONS = [
  "resumen.panel.ver",
  "ventas.negocio.ver",
  "cotizar.cotizacion.ver",
  "campanas.campana.ver",
  "finanzas.factura.ver",
  "conexiones.cuenta.ver",
  "equipo.miembro.ver",
] as const;

export type ModulePermission = (typeof MODULE_PERMISSIONS)[number];

/**
 * Los permisos de una sesión, como los entrega lib/permisos (conjunto)
 * o como llegan a la navegación (lista: las props de un componente
 * cliente viajan serializadas).
 */
export type Permisos = ReadonlySet<string> | readonly string[];

/**
 * ¿Este conjunto de permisos abre este módulo? Un módulo sin permiso
 * sí. Hasta ACC-1 un conjunto puede traer `<módulo>.*` (la matriz
 * provisional de lib/permisos escribe así el «Todo» de la fase 5);
 * con el catálogo de ACC-1 los conjuntos son exactos y el comodín
 * simplemente no aparece.
 */
export function can(permisos: Permisos, m: ModuleDef): boolean {
  if (m.permission === undefined) return true;
  return hasPermission(permisos, m.permission);
}

/** `permiso` está en el conjunto, exacto o por el comodín de su módulo. */
export function hasPermission(permisos: Permisos, permiso: string): boolean {
  const set = permisos instanceof Set ? permisos : new Set(permisos);
  return set.has(permiso) || set.has(`${permiso.split(".")[0]}.*`);
}

export const MODULES: readonly ModuleDef[] = [
  {
    slug: "resumen",
    permission: "resumen.panel.ver",
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
    permission: "ventas.negocio.ver",
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
    permission: "cotizar.cotizacion.ver",
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
    permission: "campanas.campana.ver",
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
    permission: "finanzas.factura.ver",
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
    permission: "conexiones.cuenta.ver",
    name: "Conexiones",
    group: "producto",
    phase: 1,
    owner: "nicolas",
    summary: "Las cuentas del creador y los datos que traen.",
    purpose:
      "Agregar cuentas de TikTok, Instagram y YouTube por su @ y leer cada día lo que la plataforma publica; los conectores con sus fixtures, el worker, la recolección diaria de posts y métricas y la línea base del creador. La autorización del dueño (alcance, retención, demografía) queda para una versión avanzada. Es la entrada de datos de todo el producto.",
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
    permission: "equipo.miembro.ver",
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
      "db/migrations/0023_access_control.sql (propone Nicolás, aplica Rasheed)",
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

/**
 * Módulos de producto encendidos, en el orden de la navegación. Con
 * `permisos`, solo los que esa sesión puede abrir (ACC-5): es lo que
 * pinta el menú. Sin `permisos` no se filtra por persona: es la lista
 * del plan de construcción.
 */
export function productModules(flags: Flags = defaultFlags, permisos?: Permisos): ModuleDef[] {
  return MODULES.filter((m) => m.group === "producto" && isEnabled(m, flags) && (permisos === undefined || can(permisos, m)));
}

export const PRODUCT_MODULES = productModules();
export const PHASE2_MODULES = MODULES.filter((m) => m.phase === 2);

export interface RequireModuleOptions {
  /** Se inyecta en pruebas; en la app se usan las reales. */
  flags?: Flags;
  /**
   * Los permisos de la sesión. Si se pasan, un módulo cuyo permiso no
   * está responde 404, igual que con la bandera apagada: un 403
   * confirmaría que el módulo existe. Si no se pasan, no se comprueba
   * el permiso (el llamador síncrono de /kit, que es pública).
   */
  permisos?: Permisos;
}

/**
 * El módulo de una ruta, o 404 si no existe, si su bandera está apagada
 * o —con `permisos`— si esta sesión no tiene el suyo, en ese orden.
 * Apagar una bandera o quitar un permiso cierra la ruta directa, no
 * solo la quita del menú.
 *
 * Es puro y síncrono a propósito: nav.tsx (cliente) importa este
 * archivo, así que aquí no se abre la base. El que carga los permisos
 * de la sesión es requireModuleAccess (lib/permisos/modulo.ts), que es
 * lo que llama el layout de cada módulo. El segundo argumento acepta
 * las banderas a secas, como antes de ACC-5.
 */
export function requireModule(slug: string, opciones: Flags | RequireModuleOptions = {}): ModuleDef {
  const { flags = defaultFlags, permisos } = esFlags(opciones) ? { flags: opciones } : opciones;
  const m = moduleBySlug(slug);
  if (!m || !isEnabled(m, flags)) notFound();
  if (permisos !== undefined && !can(permisos, m)) notFound();
  return m;
}

/** Un objeto de banderas tiene llaves de FLAG_KEYS; las opciones, `flags` o `permisos` (o nada). */
function esFlags(x: Flags | RequireModuleOptions): x is Flags {
  return Object.keys(x).some(isFlagKey);
}
