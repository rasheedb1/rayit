/**
 * Cotizar · COT-1, el tarifario (rate_card y rate_card_item).
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import type { Decimal, PasoCalculo, PlatformId } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { CotizarError, RateCardNotFound } from './errores.ts';
import { assertRango } from './interno.ts';

// ---------------------------------------------------------------------
// COT-1 · Tarifario
// ---------------------------------------------------------------------

export type RateCard = {
  id: string;
  creatorId: string;
  currency: string;
  version: number;
  isCurrent: boolean;
  computedAt: string;
  basis: Record<string, unknown>;
};

export type RateCardItem = {
  id: string;
  deliverable: string;
  platformId: PlatformId | null;
  labelEs: string;
  priceLow: Decimal | null;
  priceHigh: Decimal | null;
  isModifier: boolean;
  modifierPct: string | null;
  avgViews: number | null;
  cpmLow: Decimal | null;
  cpmHigh: Decimal | null;
  adjustments: Record<string, unknown>;
  /**
   * Los modificadores que el precio ya lleva dentro (derechos de uso,
   * exclusividad…), leídos de `adjustments.modificadores`. La cotización
   * los usa para no decir «Exclusividad: no aplica» sobre un precio que la
   * cobra, y el media kit para decir qué incluyen sus rangos.
   */
  modifierIds: string[];
  overridden: boolean;
  position: number;
};

interface RawRateCard {
  id: string; creator_id: string; currency: string; version: number;
  is_current: boolean; computed_at: string; basis: Record<string, unknown>;
}

interface RawRateCardItem {
  id: string; deliverable: string; platform_id: PlatformId | null; label_es: string;
  price_low: string | null; price_high: string | null; is_modifier: boolean;
  modifier_pct: string | null; avg_views: string | number | null;
  cpm_low: string | null; cpm_high: string | null;
  adjustments: Record<string, unknown>; overridden: boolean; position: number;
}

/** Los ids de modificador guardados en `adjustments`, sin confiar en su forma. */
function modificadoresDe(adjustments: Record<string, unknown> | null | undefined): string[] {
  const lista = adjustments?.modificadores;
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : [];
}

function mapItem(r: RawRateCardItem): RateCardItem {
  return {
    id: r.id,
    deliverable: r.deliverable,
    platformId: r.platform_id,
    labelEs: r.label_es,
    priceLow: r.price_low,
    priceHigh: r.price_high,
    isModifier: r.is_modifier,
    modifierPct: r.modifier_pct,
    avgViews: r.avg_views === null ? null : Number(r.avg_views),
    cpmLow: r.cpm_low,
    cpmHigh: r.cpm_high,
    adjustments: r.adjustments,
    modifierIds: r.is_modifier ? [] : modificadoresDe(r.adjustments),
    overridden: r.overridden,
    position: r.position,
  };
}

function mapCard(r: RawRateCard): RateCard {
  return {
    id: r.id,
    creatorId: r.creator_id,
    currency: r.currency.toUpperCase(),
    version: r.version,
    isCurrent: r.is_current,
    computedAt: r.computed_at,
    basis: r.basis,
  };
}

const SELECT_CARD = `SELECT id, creator_id, currency, version, is_current, computed_at, basis FROM rate_card`;
const SELECT_ITEMS = `SELECT id, deliverable, platform_id, label_es, price_low, price_high, is_modifier,
                             modifier_pct, avg_views, cpm_low, cpm_high, adjustments, overridden, position
                      FROM rate_card_item WHERE rate_card_id = $1 ORDER BY position, id`;

/** El tarifario vigente de un creador con sus entregables en orden, o null si no tiene. */
export async function getCurrentRateCard(
  tx: WorkspaceTx,
  creatorId: string,
): Promise<{ card: RateCard; items: RateCardItem[] } | null> {
  if (!isUuid(creatorId)) return null;
  const { rows } = await tx.query<RawRateCard>(
    `${SELECT_CARD} WHERE creator_id = $1 AND is_current ORDER BY version DESC LIMIT 1`,
    [creatorId],
  );
  const card = rows[0];
  if (!card) return null;
  const items = await tx.query<RawRateCardItem>(SELECT_ITEMS, [card.id]);
  return { card: mapCard(card), items: items.rows.map(mapItem) };
}

/**
 * El creador del workspace con el que trabajan las pantallas de
 * Cotizar. Hasta CIM-3 (sesión) un workspace tiene un creador; cuando
 * una agencia tenga varios, la pantalla elegirá y esta función se
 * quedará como «el primero por defecto».
 */
export async function getPrimaryCreator(tx: WorkspaceTx): Promise<{ id: string; displayName: string } | null> {
  const { rows } = await tx.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM creator_profile WHERE status = 'active' ORDER BY created_at LIMIT 1",
  );
  return rows[0] ? { id: rows[0].id, displayName: rows[0].display_name } : null;
}

/** Las views promedio que el tarifario puede usar sin que nadie las escriba. */
export interface BaselineViews {
  platformId: PlatformId;
  /** Mediana de views, redondeada a entero: la fórmula trabaja con enteros. */
  medianViews: number;
  sampleSize: number;
  ageHoursCut: number;
  /** false con menos de ocho videos: la mediana miente y la pantalla lo dice. */
  isReliable: boolean;
  computedAt: string;
}

export interface CpmBenchmark {
  nicheSlug: string;
  country: string;
  platform: PlatformId;
  currency: string;
  cpmLow: Decimal;
  cpmHigh: Decimal;
  source: string;
  sampleSize: number | null;
}

export interface RateCardInputs {
  creatorId: string;
  currency: string;
  country: string;
  nicheSlugs: string[];
  baselines: BaselineViews[];
  benchmarks: CpmBenchmark[];
}

/** El corte canónico del tarifario: lo que un video hace en una semana. */
export const CORTE_TARIFARIO_HORAS = 168;

/**
 * Todo lo que COT-1 necesita para proponer precios: la línea base de
 * views por red (la más reciente de cada una, al corte de 7 días) y el
 * CPM de referencia del nicho y el país del workspace.
 *
 * No calcula nada: la fórmula es packages/core/tarifas.ts. Aquí solo se
 * junta lo que la base ya sabe.
 */
export async function getRateCardInputs(tx: WorkspaceTx, creatorId: string): Promise<RateCardInputs | null> {
  if (!isUuid(creatorId)) return null;
  const { rows: creador } = await tx.query<{ id: string; niche_slugs: string[]; country: string | null }>(
    'SELECT id, niche_slugs, country FROM creator_profile WHERE id = $1',
    [creatorId],
  );
  if (!creador[0]) return null;

  const { rows: ws } = await tx.query<{ currency: string; country: string | null; niche_slugs: string[] }>(
    'SELECT currency, country, niche_slugs FROM workspace WHERE id = $1',
    [tx.workspaceId],
  );
  const currency = (ws[0]?.currency ?? 'COP').toUpperCase();
  const country = (creador[0].country ?? ws[0]?.country ?? 'CO').toUpperCase();
  const nichos = creador[0].niche_slugs.length > 0 ? creador[0].niche_slugs : (ws[0]?.niche_slugs ?? []);

  // La línea base más reciente de cada red al corte del tarifario; si
  // esa red no llegó al corte, la del corte mayor que sí alcanzó.
  const { rows: baselines } = await tx.query<{
    platform_id: PlatformId; median_views: string | null; sample_size: number;
    age_hours_cut: number; is_reliable: boolean; computed_at: string;
  }>(
    `SELECT DISTINCT ON (platform_id)
            platform_id, median_views, sample_size, age_hours_cut, is_reliable, computed_at
       FROM creator_baseline
      WHERE creator_id = $1 AND median_views IS NOT NULL
      ORDER BY platform_id,
               (age_hours_cut = $2) DESC,
               age_hours_cut DESC,
               computed_at DESC`,
    [creatorId, CORTE_TARIFARIO_HORAS],
  );

  // El CPM se filtra por el país del creador, pero la moneda es la del
  // workspace: una agencia en USD con una creadora de Colombia no puede
  // tomar 45.000 COP como si fueran dólares. Si hay referencia en la
  // moneda del workspace, gana esa; si solo la hay en otra, se devuelve
  // igual para que la pantalla diga «no hay CPM en USD» (y no «no hay
  // CPM»), pero la fórmula no la usa (construirFilas, en la web).
  const { rows: benchmarks } = await tx.query<{
    niche_slug: string; country: string; platform: PlatformId; currency: string;
    cpm_low: string; cpm_high: string; source: string; sample_size: number | null;
  }>(
    `SELECT DISTINCT ON (niche_slug, platform)
            niche_slug, country, platform, currency, cpm_low, cpm_high, source, sample_size
       FROM niche_cpm_benchmark
      WHERE country = $1 AND niche_slug = ANY($2::text[]) AND valid_from <= CURRENT_DATE
      ORDER BY niche_slug, platform, (upper(currency) = $3) DESC, valid_from DESC`,
    [country, nichos, currency],
  );

  return {
    creatorId,
    currency,
    country,
    nicheSlugs: nichos,
    baselines: baselines.map((b) => ({
      platformId: b.platform_id,
      medianViews: Math.round(Number(b.median_views)),
      sampleSize: b.sample_size,
      ageHoursCut: b.age_hours_cut,
      isReliable: b.is_reliable,
      computedAt: b.computed_at,
    })),
    benchmarks: benchmarks.map((b) => ({
      nicheSlug: b.niche_slug,
      country: b.country,
      platform: b.platform,
      currency: b.currency.toUpperCase(),
      cpmLow: b.cpm_low,
      cpmHigh: b.cpm_high,
      source: b.source,
      sampleSize: b.sample_size,
    })),
  };
}

export interface SaveRateCardItem {
  deliverable: string;
  platformId: PlatformId | null;
  labelEs: string;
  priceLow: Decimal;
  priceHigh: Decimal;
  avgViews: number | null;
  cpmLow: Decimal | null;
  cpmHigh: Decimal | null;
  /** Entradas y pasos del cálculo, para poder explicar el precio meses después. */
  adjustments: Record<string, unknown>;
  overridden: boolean;
}

export interface SaveRateCardInput {
  creatorId: string;
  currency: string;
  /** Las entradas de la fórmula: views, CPM, modificadores activos. */
  basis: Record<string, unknown>;
  items: SaveRateCardItem[];
}

/**
 * Guarda una VERSIÓN nueva del tarifario y la deja vigente.
 *
 * No actualiza la anterior: un precio que ya se citó en una cotización
 * tiene que seguir siendo consultable, así que el tarifario es una
 * bitácora, como las métricas. `version` sube dentro de la transacción,
 * protegida por el UNIQUE (creator_id, version) de 0008.
 */
export async function saveRateCard(tx: WorkspaceTx, input: SaveRateCardInput): Promise<{ card: RateCard; items: RateCardItem[] }> {
  if (!isUuid(input.creatorId)) throw new RateCardNotFound();
  // Antes de tocar nada: un rango al revés no se guarda a medias.
  for (const item of input.items) assertRango(item.priceLow, item.priceHigh, item.deliverable);
  const { rows: creador } = await tx.query('SELECT 1 FROM creator_profile WHERE id = $1', [input.creatorId]);
  if (!creador[0]) throw new RateCardNotFound();

  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rate-card:${input.creatorId}`]);
  const { rows: ultimo } = await tx.query<{ version: number }>(
    'SELECT coalesce(max(version), 0) AS version FROM rate_card WHERE creator_id = $1',
    [input.creatorId],
  );
  const version = Number(ultimo[0]?.version ?? 0) + 1;

  await tx.query('UPDATE rate_card SET is_current = false WHERE creator_id = $1 AND is_current', [input.creatorId]);
  const { rows: creada } = await tx.query<RawRateCard>(
    `INSERT INTO rate_card (workspace_id, creator_id, currency, version, is_current, basis)
     VALUES (current_workspace_id(), $1, $2, $3, true, $4::jsonb)
     RETURNING id, creator_id, currency, version, is_current, computed_at, basis`,
    [input.creatorId, input.currency.toUpperCase(), version, JSON.stringify(input.basis)],
  );
  const card = creada[0];
  if (!card) throw new CotizarError('RateCardInsertError', 'No se pudo guardar el tarifario.');

  for (const [i, item] of input.items.entries()) {
    await tx.query(
      `INSERT INTO rate_card_item
         (rate_card_id, deliverable, platform_id, label_es, price_low, price_high,
          avg_views, cpm_low, cpm_high, adjustments, overridden, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        card.id, item.deliverable, item.platformId, item.labelEs, item.priceLow, item.priceHigh,
        item.avgViews, item.cpmLow, item.cpmHigh, JSON.stringify(item.adjustments), item.overridden, i,
      ],
    );
  }

  const items = await tx.query<RawRateCardItem>(SELECT_ITEMS, [card.id]);
  return { card: mapCard(card), items: items.rows.map(mapItem) };
}

/**
 * El creador escribió un precio a mano. Se respeta y se marca: el
 * tarifario siguiente ya no lo recalcula, y la pantalla lo señala con
 * «editado» para que se note que ese número no lo puso la fórmula.
 */
export async function overrideRateCardItemPrice(
  tx: WorkspaceTx,
  itemId: string,
  prices: { priceLow: Decimal; priceHigh: Decimal },
): Promise<RateCardItem> {
  if (!isUuid(itemId)) throw new CotizarError('RateCardItemNotFound', 'Ese entregable no existe en el tarifario.');
  assertRango(prices.priceLow, prices.priceHigh, null);
  const { rows } = await tx.query<RawRateCardItem>(
    `UPDATE rate_card_item SET price_low = $2, price_high = $3, overridden = true
      WHERE id = $1
      RETURNING id, deliverable, platform_id, label_es, price_low, price_high, is_modifier,
                modifier_pct, avg_views, cpm_low, cpm_high, adjustments, overridden, position`,
    [itemId, prices.priceLow, prices.priceHigh],
  );
  const row = rows[0];
  if (!row) throw new CotizarError('RateCardItemNotFound', 'Ese entregable no existe en el tarifario.');
  return mapItem(row);
}

/** Los pasos del cálculo guardados en un ítem del tarifario, si los tiene. */
export function pasosDe(item: RateCardItem): PasoCalculo[] {
  const pasos = (item.adjustments as { pasos?: PasoCalculo[] }).pasos;
  return Array.isArray(pasos) ? pasos : [];
}
