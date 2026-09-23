/**
 * Lo que Ventas decide sin consultar la base: qué pestaña está activa,
 * qué pastilla le toca a cada estado y cómo se llaman en español las
 * cosas que en la base están en inglés.
 *
 * Todo aquí es puro y está probado. La regla del repositorio es que un
 * componente de React no decide colores ni etiquetas por su cuenta: si
 * mañana «prospect» pasa a llamarse de otro modo, se cambia en
 * messages.ts y no en cinco pantallas. Aquí se decide el color; el
 * texto sale de messages.ts.
 */
import type { ContactSource, DueState, Relationship, SignalStatus } from "@mc/db/queries/ventas";
import type { PillKind } from "@/components/ui/pill";
import { MESSAGES } from "./messages";

// ---------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------

/**
 * Las dos vistas que conviven en /ventas y se eligen por la URL, para
 * que un enlace a «el pipeline» se pueda compartir y el botón de atrás
 * haga lo que se espera.
 *
 * Empresas NO es una de ellas: es su propia ruta (/ventas/empresas),
 * porque tiene búsqueda, detalle y URL propias. Aparece en la misma
 * tira de navegación porque para quien usa el producto son tres sitios
 * del mismo módulo, pero solo estas dos viajan en ?vista=.
 */
export const TABS = ["radar", "pipeline"] as const;
export type TabKey = (typeof TABS)[number];

export const TAB_LABELS: Record<TabKey, string> = {
  radar: MESSAGES.tabs.radar,
  pipeline: MESSAGES.tabs.pipeline,
};

/**
 * La pestaña que pide la URL. Un valor desconocido cae en el radar, que
 * es la bandeja: lo primero que se mira al entrar.
 *
 * `includes` sobre la lista y no `in` sobre un objeto: "__proto__"
 * también está «en» un objeto y no es una pestaña.
 */
export function tabKey(value: string | undefined): TabKey {
  return TABS.includes(value as TabKey) ? (value as TabKey) : "radar";
}

/** La URL de una pestaña. El radar es la de por defecto, así que va sin parámetro. */
export function tabHref(key: TabKey): string {
  return key === "radar" ? "/ventas" : `/ventas?vista=${key}`;
}

/** La tira de navegación del módulo: las dos vistas más la ruta de Empresas. */
export const MODULE_LINKS: { href: string; label: string; exact: boolean }[] = [
  { href: tabHref("radar"), label: TAB_LABELS.radar, exact: true },
  { href: tabHref("pipeline"), label: TAB_LABELS.pipeline, exact: true },
  { href: "/ventas/empresas", label: MESSAGES.tabs.empresas, exact: false },
];

// ---------------------------------------------------------------------
// Relación con la empresa
// ---------------------------------------------------------------------

/** La etiqueta sale de messages.ts; aquí solo se decide el color. */
export const RELATIONSHIP_META: Record<Relationship, { label: string; kind: PillKind }> = {
  prospect: { label: MESSAGES.relaciones.prospect, kind: "neutral" },
  contacted: { label: MESSAGES.relaciones.contacted, kind: "warn" },
  client: { label: MESSAGES.relaciones.client, kind: "good" },
  past_client: { label: MESSAGES.relaciones.past_client, kind: "neutral" },
  blocked: { label: MESSAGES.relaciones.blocked, kind: "bad" },
};

/** Las opciones del selector de relación, en el orden en que se recorre una venta. */
export const RELATIONSHIP_OPTIONS: { value: Relationship; label: string }[] = (
  ["prospect", "contacted", "client", "past_client", "blocked"] as const
).map((value) => ({ value, label: RELATIONSHIP_META[value].label }));

// ---------------------------------------------------------------------
// Procedencia de un contacto
// ---------------------------------------------------------------------

/**
 * Cada fuente con su etiqueta y una ayuda que dice cuándo usarla; los
 * textos viven en messages.ts (MESSAGES.procedencias).
 */
export const SOURCE_META: Record<ContactSource, { label: string; help: string }> = MESSAGES.procedencias;

export const SOURCE_OPTIONS: { value: ContactSource; label: string }[] = (
  ["public_website", "public_profile", "inbound", "user_provided", "press", "enrichment_vendor"] as const
).map((value) => ({ value, label: SOURCE_META[value].label }));

// ---------------------------------------------------------------------
// Señales
// ---------------------------------------------------------------------

export const SIGNAL_STATUS_META: Record<SignalStatus, { label: string; kind: PillKind }> = {
  pending: { label: MESSAGES.estadosSenal.pending, kind: "warn" },
  accepted: { label: MESSAGES.estadosSenal.accepted, kind: "good" },
  discarded: { label: MESSAGES.estadosSenal.discarded, kind: "neutral" },
  expired: { label: MESSAGES.estadosSenal.expired, kind: "neutral" },
  duplicate: { label: MESSAGES.estadosSenal.duplicate, kind: "neutral" },
};

// ---------------------------------------------------------------------
// Seguimiento
// ---------------------------------------------------------------------

/**
 * La pastilla del seguimiento de un negocio.
 *
 * «Sin fecha» es `warn` y no `neutral` a propósito: un negocio abierto
 * sin siguiente acción es el problema que esta pantalla existe para
 * señalar, no un estado más.
 */
export function pillForDue(state: DueState): { kind: PillKind; text: string } {
  switch (state) {
    case "vencido":
      return { kind: "bad", text: MESSAGES.due.vencido };
    case "hoy":
      return { kind: "warn", text: MESSAGES.due.hoy };
    case "sin_fecha":
      return { kind: "warn", text: MESSAGES.due.sin_fecha };
    case "futuro":
      return { kind: "neutral", text: MESSAGES.due.futuro };
  }
}

/**
 * Un negocio abierto sin siguiente acción se marca. Los cerrados no:
 * a un negocio ganado no le falta nada.
 */
export function needsNextAction(deal: { nextAction: string | null; isWon: boolean; isLost: boolean }): boolean {
  return !deal.isWon && !deal.isLost && !deal.nextAction;
}

// ---------------------------------------------------------------------
// Encaje
// ---------------------------------------------------------------------

/**
 * El encaje llega como string decimal 0..1 (numeric de Postgres, que no
 * se convierte a number en la capa de datos). Aquí se pasa a porcentaje
 * entero UNA vez, para pintarlo. No es aritmética de métricas: es dar
 * formato a un número que ya viene calculado.
 */
export function fitPercent(fitScore: string | null): number | null {
  if (fitScore === null) return null;
  const n = Number(fitScore);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Verde de 75 % para arriba, ámbar de 50 a 74, y por debajo sin color. */
export function pillForFit(fitScore: string | null): { kind: PillKind; text: string } | null {
  const pct = fitPercent(fitScore);
  if (pct === null) return null;
  const kind: PillKind = pct >= 75 ? "good" : pct >= 50 ? "warn" : "neutral";
  return { kind, text: `${pct} %` };
}

/**
 * Lo contrario de `fitPercent`: el «80» que escribe una persona pasa a
 * «0.80», que es lo que guarda `signal.fit_score`. Vacío es «sin
 * encaje»; fuera de 0..100 o con letras, `undefined` para que el
 * formulario lo marque como error.
 */
export function fitFromPercent(raw: string): string | null | undefined {
  const v = raw.trim().replace(",", ".");
  if (v === "") return null;
  if (!/^\d{1,3}(\.\d+)?$/.test(v)) return undefined;
  const n = Number(v);
  if (n < 0 || n > 100) return undefined;
  return (Math.round(n) / 100).toFixed(2);
}

// ---------------------------------------------------------------------
// Pipeline: tablero o lista, y el movimiento optimista
// ---------------------------------------------------------------------

export const PIPELINE_FORMAS = ["tablero", "lista"] as const;
export type PipelineForma = (typeof PIPELINE_FORMAS)[number];

/** La forma que pide la URL (`?forma=lista`). Por defecto, el tablero. */
export function pipelineForma(value: string | undefined): PipelineForma {
  return PIPELINE_FORMAS.includes(value as PipelineForma) ? (value as PipelineForma) : "tablero";
}

/**
 * El pipeline con un negocio ya en su etapa nueva, antes de que el
 * servidor conteste. Solo cambia la columna y la etiqueta: los montos
 * por etapa y los KPI llegan recalculados de SQL cuando la página se
 * revalida, y aquí no se suman.
 */
export function applyMove<T extends { id: string; stageId: string; stageLabel: string; daysInStage: number }>(
  deals: T[],
  move: { dealId: string; toStageId: string; toStageLabel: string },
): T[] {
  return deals.map((d) =>
    d.id === move.dealId && d.stageId !== move.toStageId
      ? { ...d, stageId: move.toStageId, stageLabel: move.toStageLabel, daysInStage: 0 }
      : d,
  );
}
