/**
 * Consultas del módulo Cotizar. Dueño: Rasheed (COT-1 … COT-4).
 *
 * Tres cosas viven aquí: el tarifario (rate_card), el media kit
 * congelado (media_kit) y la cotización con su enlace público (quote).
 *
 * Reglas del archivo, las mismas de todo queries/:
 *   - Toda función del panel recibe un WorkspaceTx: RLS filtra las
 *     lecturas y los INSERT usan current_workspace_id(). Nadie pasa un
 *     workspace_id suelto.
 *   - Un id que llega de fuera se valida con `isUuid` ANTES de
 *     consultar: `/cotizar/no-soy-uuid` tiene que ser un 404 del
 *     producto, no un 22P02 convertido en 500.
 *   - El dinero entra y sale como string decimal. Ninguna consulta hace
 *     aritmética de dinero: la hace packages/core (tarifas.ts), y por
 *     eso el número que el creador ve mientras edita es el que se
 *     guarda.
 *   - Las fechas `date` salen como 'YYYY-MM-DD' (to_char), sin depender
 *     de la zona del driver.
 *
 * Y las TRES funciones públicas del final (readPublicMediaKit,
 * readPublicQuote, acceptPublicQuote) son la excepción explicada: no
 * reciben WorkspaceTx porque la marca abre el enlace sin sesión. No
 * consultan tablas: llaman a las funciones SECURITY DEFINER de las
 * migraciones 0022 y 0023, que corren como mc_public_share y son a la
 * vez la puerta y el registro de la visita. Ver la cabecera de 0023
 * para por qué las políticas llevan `TO mc_public_share`.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  calcularTotalesCotizacion, DEFAULT_TAX_RATE, type Decimal, type PasoCalculo, type PlatformId,
} from '@mc/core';
import { isUuid, type BaseTx, type WorkspaceTx } from '../client.ts';
import { createCampaignFromQuote } from './campanas.ts';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export class CotizarError extends Error {
  readonly code: string;
  /** Lo que se le puede enseñar a una persona, en español. */
  readonly messageEs: string;
  constructor(code: string, messageEs: string) {
    super(messageEs);
    this.name = 'CotizarError';
    this.code = code;
    this.messageEs = messageEs;
  }
}

export class QuoteNotFound extends CotizarError {
  constructor() {
    super('QuoteNotFound', 'Esa cotización no existe en este espacio de trabajo.');
  }
}

export class QuoteNotEditable extends CotizarError {
  constructor(status: string) {
    super('QuoteNotEditable', `Una cotización en «${status}» ya no se edita: duplícala si necesitas cambiarla.`);
  }
}

export class QuoteTransitionError extends CotizarError {
  constructor(from: string, to: string) {
    super('QuoteTransitionError', `Una cotización en «${from}» no puede pasar a «${to}».`);
  }
}

export class RateCardNotFound extends CotizarError {
  constructor() {
    super('RateCardNotFound', 'Ese creador todavía no tiene tarifario.');
  }
}

export class MediaKitNotFound extends CotizarError {
  constructor() {
    super('MediaKitNotFound', 'Ese media kit no existe en este espacio de trabajo.');
  }
}

export class QuoteNotDraft extends CotizarError {
  constructor(status: string) {
    super('QuoteNotDraft', `Solo un borrador se borra; esta cotización está en «${status}».`);
  }
}

// ---------------------------------------------------------------------
// Enlaces compartidos: slug y contraseña
// ---------------------------------------------------------------------

/**
 * El slug es la credencial del enlace, así que se sortea, no se deriva
 * del nombre. El alfabeto (31 signos) deja fuera los que se confunden al
 * dictarlos o copiarlos a mano (0/o, 1/l/i). 26 signos de 31 son
 * 26 × log2(31) ≈ 128,8 bits: no se enumeran.
 */
const ALFABETO = '23456789abcdefghjkmnpqrstuvwxyz';
export const LARGO_SLUG = 26;

/**
 * Muestreo por rechazo: un byte vale 0–255 y 256 no es múltiplo de 31,
 * así que `b % 31` favorecería a los primeros ocho signos. Se descartan
 * los bytes ≥ 248 (el mayor múltiplo de 31 que cabe) y cada signo sale
 * con la misma probabilidad.
 */
export function nuevoSlug(largo = LARGO_SLUG): string {
  const n = ALFABETO.length;
  const limite = 256 - (256 % n);
  let out = '';
  while (out.length < largo) {
    for (const b of randomBytes(largo * 2)) {
      if (b >= limite) continue;
      out += ALFABETO[b % n];
      if (out.length === largo) break;
    }
  }
  return out;
}

const SCRYPT_KEYLEN = 32;

/** scrypt sin bloquear el bucle de eventos: cada intento de contraseña cuesta CPU de verdad. */
function scryptAsync(secreto: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secreto, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Deriva la contraseña de un enlace. Formato: 's1:<sal hex>:<scrypt hex>'.
 * La contraseña en claro no se guarda ni viaja a la base: la base
 * compara derivados (ver migraciones 0022 y 0023).
 */
export async function hashSharePassword(secreto: string, saltHex = randomBytes(16).toString('hex')): Promise<string> {
  const clave = await scryptAsync(secreto.normalize('NFKC'), Buffer.from(saltHex, 'hex'));
  return `s1:${saltHex}:${clave.toString('hex')}`;
}

/** true si la contraseña deriva en el hash guardado. Comparación en tiempo constante. */
export async function verifySharePassword(secreto: string, stored: string): Promise<boolean> {
  const [algo, saltHex] = stored.split(':');
  if (algo !== 's1' || !saltHex) return false;
  const a = Buffer.from(await hashSharePassword(secreto, saltHex));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

  const { rows: benchmarks } = await tx.query<{
    niche_slug: string; country: string; platform: PlatformId; currency: string;
    cpm_low: string; cpm_high: string; source: string; sample_size: number | null;
  }>(
    `SELECT DISTINCT ON (niche_slug, platform)
            niche_slug, country, platform, currency, cpm_low, cpm_high, source, sample_size
       FROM niche_cpm_benchmark
      WHERE country = $1 AND niche_slug = ANY($2::text[]) AND valid_from <= CURRENT_DATE
      ORDER BY niche_slug, platform, valid_from DESC`,
    [country, nichos],
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

// ---------------------------------------------------------------------
// COT-2 · Media kit
// ---------------------------------------------------------------------

export interface MediaKitSnapshotRed {
  platformId: PlatformId;
  handle: string | null;
  followers: number | null;
  /** Día de la última lectura de seguidores. */
  followersAsOf: string | null;
  medianViews: number | null;
  engagement: string | null;
  sampleSize: number | null;
  isReliable: boolean;
}

export interface MediaKitSnapshotPost {
  platformId: PlatformId;
  url: string | null;
  caption: string | null;
  publishedAt: string;
  views: number | null;
  viewsVsMedian: string | null;
}

export interface MediaKitSnapshotTarifa {
  labelEs: string;
  platformId: PlatformId | null;
  priceLow: Decimal | null;
  priceHigh: Decimal | null;
}

/**
 * La audiencia de UNA red y UNA dimensión («Edad · Instagram»). Mezclar
 * cuentas y dimensiones en una sola lista dejaba pastillas repetidas y
 * sin contexto («25-34 · 40 %» tres veces).
 */
export interface MediaKitSnapshotAudiencia {
  platformId: PlatformId;
  /** 'age' | 'gender' | 'country' | … Tal cual la guarda audience_breakdown. */
  dimension: string;
  buckets: { bucket: string; share: string | null }[];
}

export interface MediaKitSnapshot {
  /** 2 desde que la audiencia va agrupada por red y dimensión. */
  version: 2;
  /** Cuándo se congeló. Lo que se enseña como «datos hasta…». */
  capturedAt: string;
  creator: { displayName: string; handle: string | null; bio: string | null; country: string | null; nicheSlugs: string[] };
  /** Moneda, locale y zona del workspace, congelados: la página pública no tiene workspace que consultar. */
  currency: string;
  locale: string;
  timezone: string;
  redes: MediaKitSnapshotRed[];
  totales: { followers: number | null; medianViewsMax: number | null };
  topPosts: MediaKitSnapshotPost[];
  /** De la red con más seguidores que tenga demografía; una entrada por dimensión. */
  audiencia: MediaKitSnapshotAudiencia[];
  tarifas: MediaKitSnapshotTarifa[];
}

/**
 * Congela los números del creador AHORA. Lo que se guarda es lo que la
 * marca verá dentro de tres meses: un media kit que cambia solo no se
 * puede citar en una negociación.
 */
export async function buildMediaKitSnapshot(tx: WorkspaceTx, creatorId: string): Promise<MediaKitSnapshot> {
  if (!isUuid(creatorId)) throw new CotizarError('CreatorNotFound', 'Ese creador no existe en este espacio de trabajo.');
  const { rows: creadores } = await tx.query<{
    display_name: string; handle: string | null; bio: string | null; country: string | null; niche_slugs: string[];
  }>('SELECT display_name, handle, bio, country, niche_slugs FROM creator_profile WHERE id = $1', [creatorId]);
  const creador = creadores[0];
  if (!creador) throw new CotizarError('CreatorNotFound', 'Ese creador no existe en este espacio de trabajo.');

  const { rows: ws } = await tx.query<{ currency: string; locale: string; timezone: string }>(
    'SELECT currency, locale, timezone FROM workspace WHERE id = $1',
    [tx.workspaceId],
  );

  // Seguidores: la última lectura de cada cuenta conectada.
  const { rows: redes } = await tx.query<{
    platform_id: PlatformId; handle: string | null; followers: string | null; day: string | null;
  }>(
    `SELECT DISTINCT ON (c.platform_id)
            c.platform_id, c.handle, s.followers, to_char(s.day, 'YYYY-MM-DD') AS day
       FROM social_connection c
       LEFT JOIN account_metric_snapshot s ON s.connection_id = c.id
      WHERE c.creator_id = $1
      ORDER BY c.platform_id, s.day DESC NULLS LAST`,
    [creatorId],
  );

  const { rows: baselines } = await tx.query<{
    platform_id: PlatformId; median_views: string | null; median_engagement: string | null;
    sample_size: number; is_reliable: boolean;
  }>(
    `SELECT DISTINCT ON (platform_id) platform_id, median_views, median_engagement, sample_size, is_reliable
       FROM creator_baseline
      WHERE creator_id = $1
      ORDER BY platform_id, (age_hours_cut = $2) DESC, age_hours_cut DESC, computed_at DESC`,
    [creatorId, CORTE_TARIFARIO_HORAS],
  );
  const porRed = new Map(baselines.map((b) => [b.platform_id, b]));

  const { rows: posts } = await tx.query<{
    platform_id: PlatformId; url: string | null; caption: string | null;
    published_at: string; views: string | null; views_vs_median: string | null;
  }>(
    `SELECT platform_id, url, caption, published_at, views, views_vs_median
       FROM creator_post_board
      WHERE creator_id = $1 AND views IS NOT NULL
      ORDER BY views DESC
      LIMIT 6`,
    [creatorId],
  );

  // La audiencia de la red principal (la de más seguidores que tenga
  // demografía), su último día, una fila por dimensión y segmento. La
  // edad va en orden de edad; el resto, de mayor a menor.
  const { rows: audiencia } = await tx.query<{
    platform_id: PlatformId; dimension: string; bucket: string; share: string | null;
  }>(
    `WITH principal AS (
       SELECT c.id, c.platform_id
         FROM social_connection c
         LEFT JOIN LATERAL (
           SELECT s.followers FROM account_metric_snapshot s
            WHERE s.connection_id = c.id ORDER BY s.day DESC LIMIT 1
         ) f ON true
        WHERE c.creator_id = $1
          AND EXISTS (SELECT 1 FROM audience_breakdown a
                       WHERE a.connection_id = c.id AND a.scope = 'account' AND a.population = 'followers')
        ORDER BY f.followers DESC NULLS LAST, c.platform_id
        LIMIT 1
     ), ultimo AS (
       SELECT DISTINCT ON (a.dimension, a.bucket) p.platform_id, a.dimension, a.bucket, a.share
         FROM principal p
         JOIN audience_breakdown a
           ON a.connection_id = p.id AND a.scope = 'account' AND a.population = 'followers'
        WHERE a.day = (SELECT max(b.day) FROM audience_breakdown b
                        WHERE b.connection_id = p.id AND b.scope = 'account' AND b.population = 'followers')
        ORDER BY a.dimension, a.bucket, a.captured_at DESC
     )
     SELECT platform_id, dimension, bucket, share
       FROM ultimo
      ORDER BY CASE dimension WHEN 'age' THEN 1 WHEN 'gender' THEN 2 WHEN 'country' THEN 3 ELSE 4 END,
               dimension,
               CASE WHEN dimension = 'age' THEN bucket END,
               share DESC NULLS LAST`,
    [creatorId],
  );
  const audienciaAgrupada: MediaKitSnapshotAudiencia[] = [];
  for (const a of audiencia) {
    let grupo = audienciaAgrupada.at(-1);
    if (!grupo || grupo.dimension !== a.dimension) {
      grupo = { platformId: a.platform_id, dimension: a.dimension, buckets: [] };
      audienciaAgrupada.push(grupo);
    }
    // Ocho segmentos por dimensión bastan para una página que se lee de pie.
    if (grupo.buckets.length < 8) grupo.buckets.push({ bucket: a.bucket, share: a.share });
  }

  const tarifario = await getCurrentRateCard(tx, creatorId);

  const redesSnapshot: MediaKitSnapshotRed[] = redes.map((r) => {
    const b = porRed.get(r.platform_id);
    return {
      platformId: r.platform_id,
      handle: r.handle,
      followers: r.followers === null ? null : Number(r.followers),
      followersAsOf: r.day,
      medianViews: b?.median_views ? Math.round(Number(b.median_views)) : null,
      engagement: b?.median_engagement ?? null,
      sampleSize: b?.sample_size ?? null,
      isReliable: b?.is_reliable ?? false,
    };
  });

  const followers = redesSnapshot.reduce<number | null>(
    (acc, r) => (r.followers === null ? acc : (acc ?? 0) + r.followers),
    null,
  );
  const medianViewsMax = redesSnapshot.reduce<number | null>(
    (acc, r) => (r.medianViews === null ? acc : Math.max(acc ?? 0, r.medianViews)),
    null,
  );

  return {
    version: 2,
    capturedAt: new Date().toISOString(),
    creator: {
      displayName: creador.display_name,
      handle: creador.handle,
      bio: creador.bio,
      country: creador.country,
      nicheSlugs: creador.niche_slugs,
    },
    currency: (ws[0]?.currency ?? 'COP').toUpperCase(),
    locale: ws[0]?.locale ?? 'es-CO',
    timezone: ws[0]?.timezone ?? 'UTC',
    redes: redesSnapshot,
    totales: { followers, medianViewsMax },
    topPosts: posts.map((p) => ({
      platformId: p.platform_id,
      url: p.url,
      caption: p.caption,
      publishedAt: p.published_at,
      views: p.views === null ? null : Number(p.views),
      viewsVsMedian: p.views_vs_median,
    })),
    audiencia: audienciaAgrupada,
    tarifas: (tarifario?.items ?? [])
      .filter((i) => !i.isModifier)
      .map((i) => ({ labelEs: i.labelEs, platformId: i.platformId, priceLow: i.priceLow, priceHigh: i.priceHigh })),
  };
}

export interface MediaKitRow {
  id: string;
  slug: string;
  creatorId: string;
  rateCardId: string | null;
  isPublic: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  viewCount: number;
  createdAt: string;
  snapshot: MediaKitSnapshot;
}

interface RawMediaKit {
  id: string; slug: string; creator_id: string; rate_card_id: string | null;
  is_public: boolean; password_hash: string | null; expires_at: string | null;
  view_count: number; created_at: string; snapshot: MediaKitSnapshot;
}

const SELECT_KIT = `SELECT id, slug, creator_id, rate_card_id, is_public, password_hash, expires_at,
                           view_count, created_at, snapshot FROM media_kit`;

function mapKit(r: RawMediaKit): MediaKitRow {
  return {
    id: r.id,
    slug: r.slug,
    creatorId: r.creator_id,
    rateCardId: r.rate_card_id,
    isPublic: r.is_public,
    hasPassword: r.password_hash !== null,
    expiresAt: r.expires_at,
    viewCount: r.view_count,
    createdAt: r.created_at,
    snapshot: r.snapshot,
  };
}

export interface CreateMediaKitInput {
  creatorId: string;
  /** Contraseña en claro; se deriva aquí y nunca se guarda tal cual. */
  password?: string | null;
  /** ISO. Sin fecha, el enlace no vence. */
  expiresAt?: string | null;
  isPublic?: boolean;
}

/** Genera el media kit con las cifras de hoy congeladas y su enlace. */
export async function createMediaKit(tx: WorkspaceTx, input: CreateMediaKitInput): Promise<MediaKitRow> {
  const snapshot = await buildMediaKitSnapshot(tx, input.creatorId);
  const tarifario = await getCurrentRateCard(tx, input.creatorId);
  const passwordHash = input.password ? await hashSharePassword(input.password) : null;

  const { rows } = await tx.query<RawMediaKit>(
    `INSERT INTO media_kit (workspace_id, creator_id, rate_card_id, slug, snapshot, is_public, password_hash, expires_at)
     VALUES (current_workspace_id(), $1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id, slug, creator_id, rate_card_id, is_public, password_hash, expires_at, view_count, created_at, snapshot`,
    [
      input.creatorId, tarifario?.card.id ?? null, nuevoSlug(), JSON.stringify(snapshot),
      input.isPublic ?? true, passwordHash, input.expiresAt ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new CotizarError('MediaKitInsertError', 'No se pudo generar el media kit.');
  return mapKit(row);
}

export async function listMediaKits(tx: WorkspaceTx): Promise<MediaKitRow[]> {
  const { rows } = await tx.query<RawMediaKit>(`${SELECT_KIT} ORDER BY created_at DESC LIMIT 50`);
  return rows.map(mapKit);
}

export async function getMediaKitById(tx: WorkspaceTx, id: string): Promise<MediaKitRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawMediaKit>(`${SELECT_KIT} WHERE id = $1`, [id]);
  return rows[0] ? mapKit(rows[0]) : null;
}

export interface UpdateMediaKitShareInput {
  isPublic?: boolean;
  /** null quita la contraseña; undefined la deja como está. */
  password?: string | null;
  /** null quita el vencimiento; undefined lo deja como está. */
  expiresAt?: string | null;
}

/** Cambia cómo se comparte, nunca las cifras: el snapshot es inmutable. */
export async function updateMediaKitShare(tx: WorkspaceTx, id: string, input: UpdateMediaKitShareInput): Promise<MediaKitRow> {
  if (!isUuid(id)) throw new MediaKitNotFound();
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (input.isPublic !== undefined) {
    values.push(input.isPublic);
    sets.push(`is_public = $${values.length}`);
  }
  if (input.password !== undefined) {
    values.push(input.password === null ? null : await hashSharePassword(input.password));
    sets.push(`password_hash = $${values.length}`);
  }
  if (input.expiresAt !== undefined) {
    values.push(input.expiresAt);
    sets.push(`expires_at = $${values.length}`);
  }
  if (sets.length === 0) {
    const actual = await getMediaKitById(tx, id);
    if (!actual) throw new MediaKitNotFound();
    return actual;
  }
  const { rows } = await tx.query<RawMediaKit>(
    `UPDATE media_kit SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, slug, creator_id, rate_card_id, is_public, password_hash, expires_at, view_count, created_at, snapshot`,
    values,
  );
  const row = rows[0];
  if (!row) throw new MediaKitNotFound();
  return mapKit(row);
}

// ---------------------------------------------------------------------
// COT-3 · Cotización
// ---------------------------------------------------------------------

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteItemRow {
  id: string;
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: Decimal;
  total: Decimal;
  position: number;
}

export interface QuoteListRow {
  id: string;
  number: string;
  slug: string;
  /**
   * El estado de HOY: una enviada o vista cuya validez ya pasó sale
   * 'expired' aunque la marca nunca haya vuelto a abrir el enlace.
   * Lo deriva la consulta (ver SELECT_QUOTE), no la pantalla.
   */
  status: QuoteStatus;
  companyId: string;
  companyName: string;
  dealId: string | null;
  dealName: string | null;
  currency: string;
  total: Decimal;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  viewCount: number;
  createdAt: string;
}

export interface QuoteDetail extends QuoteListRow {
  creatorId: string;
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  /** La tasa con la que se calculó `tax`, como fracción ('0.19'). null en cotizaciones anteriores a 0023. */
  taxRate: string | null;
  agreedMetrics: string[];
  reportCutsHours: number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
  campaignStartsOn: string | null;
  campaignEndsOn: string | null;
  mediaKitId: string | null;
  /** Quién aceptó desde el enlace (nombre y correo que dejó la marca). */
  acceptedByName: string | null;
  acceptedByEmail: string | null;
  items: QuoteItemRow[];
  /** La campaña que nació de esta cotización (CAM-2), si ya existe. */
  campaignId: string | null;
  campaignName: string | null;
  /** true cuando está aceptada y todavía no tiene campaña. */
  campaignPending: boolean;
}

interface RawQuote {
  id: string; number: string; slug: string; status: QuoteStatus;
  company_id: string; company_name: string; deal_id: string | null; deal_name: string | null;
  creator_id: string; currency: string; subtotal: string; discount: string; tax: string; total: string;
  tax_rate: string | null;
  agreed_metrics: string[]; report_cuts_hours: number[];
  usage_rights_days: number | null; exclusivity_days: number | null; exclusivity_scope: string | null;
  payment_terms_days: number; campaign_starts_on: string | null; campaign_ends_on: string | null;
  media_kit_id: string | null;
  valid_until: string | null; sent_at: string | null; viewed_at: string | null; accepted_at: string | null;
  rejected_at: string | null; expired_at: string | null;
  accepted_by_name: string | null; accepted_by_email: string | null;
  view_count: number; created_at: string;
  campaign_id: string | null; campaign_name: string | null;
}

/**
 * La cotización con su estado DE HOY. `vencida` se evalúa en la zona del
 * workspace: «válida hasta el 30» quiere decir hasta el final del 30 en
 * Bogotá, no a las 19:00. La fecha de vencimiento derivada es el
 * principio del día siguiente en esa zona, que es cuando dejó de valer.
 *
 * Es la misma regla que aplica public_quote() (0023) al abrir el enlace,
 * que además la persiste. Aquí solo se lee: un GET del panel no escribe.
 */
const SELECT_QUOTE = `
  SELECT q.id, q.number, q.slug,
         CASE WHEN v.vencida THEN 'expired' ELSE q.status END AS status,
         q.company_id, co.name AS company_name,
         q.deal_id, d.name AS deal_name, q.creator_id, q.currency,
         q.subtotal, q.discount, q.tax, q.total, q.tax_rate,
         q.agreed_metrics, q.report_cuts_hours, q.usage_rights_days, q.exclusivity_days,
         q.exclusivity_scope, q.payment_terms_days, q.media_kit_id,
         to_char(q.campaign_starts_on, 'YYYY-MM-DD') AS campaign_starts_on,
         to_char(q.campaign_ends_on, 'YYYY-MM-DD')   AS campaign_ends_on,
         to_char(q.valid_until, 'YYYY-MM-DD')        AS valid_until,
         q.sent_at, q.viewed_at, q.accepted_at, q.rejected_at,
         CASE WHEN v.vencida THEN coalesce(q.expired_at, (q.valid_until + 1)::timestamp AT TIME ZONE w.timezone)
              ELSE q.expired_at END AS expired_at,
         q.accepted_by_name, q.accepted_by_email,
         q.view_count, q.created_at,
         ca.id AS campaign_id, ca.name AS campaign_name
    FROM quote q
    JOIN workspace w ON w.id = q.workspace_id
    JOIN company co ON co.id = q.company_id
    LEFT JOIN deal d ON d.id = q.deal_id
    LEFT JOIN campaign ca ON ca.quote_id = q.id AND ca.status <> 'cancelled'
    CROSS JOIN LATERAL (
      SELECT q.status IN ('sent', 'viewed') AND q.valid_until IS NOT NULL
             AND q.valid_until < (now() AT TIME ZONE w.timezone)::date AS vencida
    ) v`;

function mapQuote(r: RawQuote): QuoteDetail {
  return {
    id: r.id,
    number: r.number,
    slug: r.slug,
    status: r.status,
    companyId: r.company_id,
    companyName: r.company_name,
    dealId: r.deal_id,
    dealName: r.deal_name,
    creatorId: r.creator_id,
    currency: r.currency.toUpperCase(),
    subtotal: r.subtotal,
    discount: r.discount,
    tax: r.tax,
    taxRate: r.tax_rate === null ? null : normalizarTasa(r.tax_rate),
    total: r.total,
    agreedMetrics: r.agreed_metrics ?? [],
    reportCutsHours: r.report_cuts_hours ?? [],
    usageRightsDays: r.usage_rights_days,
    exclusivityDays: r.exclusivity_days,
    exclusivityScope: r.exclusivity_scope,
    paymentTermsDays: r.payment_terms_days,
    campaignStartsOn: r.campaign_starts_on,
    campaignEndsOn: r.campaign_ends_on,
    mediaKitId: r.media_kit_id,
    validUntil: r.valid_until,
    sentAt: r.sent_at,
    viewedAt: r.viewed_at,
    acceptedAt: r.accepted_at,
    rejectedAt: r.rejected_at,
    expiredAt: r.expired_at,
    acceptedByName: r.accepted_by_name,
    acceptedByEmail: r.accepted_by_email,
    viewCount: r.view_count,
    createdAt: r.created_at,
    items: [],
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    campaignPending: r.status === 'accepted' && r.campaign_id === null,
  };
}

/** '0.190000' → '0.19'. Postgres devuelve numeric(7,6) con sus seis decimales. */
function normalizarTasa(tasa: string): string {
  const [i = '0', f = ''] = tasa.split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
}

export async function listQuotes(tx: WorkspaceTx, opts: { status?: readonly QuoteStatus[] } = {}): Promise<QuoteListRow[]> {
  // El filtro va sobre el estado de hoy, no sobre la columna: «vencidas»
  // tiene que traer también las que nadie ha vuelto a abrir.
  const filtrar = opts.status && opts.status.length > 0;
  const { rows } = await tx.query<RawQuote>(
    `SELECT * FROM (${SELECT_QUOTE}) x${filtrar ? ' WHERE x.status = ANY($1::text[])' : ''}
      ORDER BY x.created_at DESC LIMIT 200`,
    filtrar ? [[...opts.status!]] : [],
  );
  return rows.map(mapQuote);
}

/** Una cotización con sus ítems, o null si no existe (o no es de este workspace). */
export async function getQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawQuote>(`${SELECT_QUOTE} WHERE q.id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  const quote = mapQuote(row);
  quote.items = await listQuoteItems(tx, id);
  return quote;
}

async function listQuoteItems(tx: WorkspaceTx, quoteId: string): Promise<QuoteItemRow[]> {
  const { rows } = await tx.query<{
    id: string; deliverable: string; platform_id: PlatformId | null; description: string;
    quantity: number; unit_price: string; total: string; position: number;
  }>(
    `SELECT id, deliverable, platform_id, description, quantity, unit_price, total, position
       FROM quote_item WHERE quote_id = $1 ORDER BY position, id`,
    [quoteId],
  );
  return rows.map((r) => ({
    id: r.id,
    deliverable: r.deliverable,
    platformId: r.platform_id,
    description: r.description,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    total: r.total,
    position: r.position,
  }));
}

/** Los deals que pueden recibir una cotización: abiertos, con su empresa. */
export interface QuotableDeal {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  stageId: string;
  stageLabel: string;
  amount: Decimal | null;
  currency: string;
}

/**
 * Los negocios ABIERTOS: ni ganados ni perdidos. Cotizar un negocio
 * ganado no lo movía a «Propuesta enviada» ni hacía nada en Ventas al
 * aceptarse, y encabezaba la lista porque se ordenaba por etapa.
 * El orden es el del último movimiento: el negocio que se tocó hoy es
 * el que se está cotizando.
 */
export async function listQuotableDeals(tx: WorkspaceTx): Promise<QuotableDeal[]> {
  const { rows } = await tx.query<{
    id: string; name: string; company_id: string; company_name: string;
    stage_id: string; stage_label: string; amount: string | null; currency: string;
  }>(
    `SELECT p.id, p.name, p.company_id, p.company_name, p.stage_id, p.stage_label, p.amount, p.currency
       FROM deal_pipeline p
       LEFT JOIN LATERAL (SELECT max(h.changed_at) AS ultimo FROM deal_stage_history h WHERE h.deal_id = p.id) h ON true
      WHERE NOT p.is_lost AND NOT p.is_won
      ORDER BY greatest(h.ultimo, p.last_contact_at) DESC NULLS LAST, p.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    companyId: r.company_id,
    companyName: r.company_name,
    stageId: r.stage_id,
    stageLabel: r.stage_label,
    amount: r.amount,
    currency: r.currency.toUpperCase(),
  }));
}

const TASA_RE = /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/;

/**
 * La tasa de impuesto con la que arranca una cotización nueva, como
 * fracción. Sale del workspace: `settings.taxRate` si el creador la
 * fijó; si no, el IVA general cuando el workspace es de Colombia (el
 * único valor por defecto que el producto puede tener fijado a un
 * país), y 0 en cualquier otro sitio, donde es mejor que el creador la
 * escriba a que la cotización salga con el IVA de otro país.
 */
export async function getDefaultTaxRate(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ tax_rate: string | null; country: string | null }>(
    "SELECT settings->>'taxRate' AS tax_rate, country FROM workspace WHERE id = $1",
    [tx.workspaceId],
  );
  const fila = rows[0];
  const propia = fila?.tax_rate?.trim();
  if (propia && TASA_RE.test(propia)) return propia;
  return fila?.country?.toUpperCase() === 'CO' ? DEFAULT_TAX_RATE : '0';
}

export interface QuoteItemInput {
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: Decimal;
}

export interface CreateQuoteInput {
  /** Desde un deal: la empresa sale de él. */
  dealId?: string | null;
  companyId?: string;
  creatorId: string;
  items: QuoteItemInput[];
  discount?: Decimal;
  /** Fracción: '0.19'. */
  taxRate?: string;
  validUntil?: string | null;
  agreedMetrics?: string[];
  reportCutsHours?: number[];
  usageRightsDays?: number | null;
  exclusivityDays?: number | null;
  exclusivityScope?: string | null;
  paymentTermsDays?: number;
  campaignStartsOn?: string | null;
  campaignEndsOn?: string | null;
  mediaKitId?: string | null;
}

/**
 * Numeración COT-AAAA-NNN por workspace.
 *
 * El bloqueo consultivo se toma DENTRO de la transacción de quien llama
 * y se suelta al confirmar: dos creadores del mismo workspace que
 * cotizan a la vez se serializan aquí en vez de chocar contra el
 * UNIQUE (workspace_id, number) de 0008. El UNIQUE sigue siendo la
 * garantía de la base; esto es lo que evita el error.
 */
export async function nextQuoteNumber(tx: WorkspaceTx, year = new Date().getUTCFullYear()): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quote-number:${tx.workspaceId}:${year}`]);
  const prefijo = `COT-${year}-`;
  const { rows } = await tx.query<{ n: number | null }>(
    `SELECT max(nullif(regexp_replace(substring(number from ${prefijo.length + 1}), '\\D', '', 'g'), '')::int) AS n
       FROM quote WHERE number LIKE $1`,
    [`${prefijo}%`],
  );
  const siguiente = Number(rows[0]?.n ?? 0) + 1;
  return `${prefijo}${String(siguiente).padStart(3, '0')}`;
}

function tasaParaGuardar(taxRate: string | undefined): string | null {
  if (!taxRate || taxRate.trim() === '') return null;
  const t = taxRate.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t) || Number(t) > 1) {
    throw new CotizarError('TasaInvalida', 'El impuesto es un porcentaje entre 0 y 100.');
  }
  return t;
}

/** Crea la cotización en borrador, con sus ítems y sus totales ya calculados por core. */
export async function createQuote(tx: WorkspaceTx, input: CreateQuoteInput): Promise<QuoteDetail> {
  if (!isUuid(input.creatorId)) throw new CotizarError('CreatorNotFound', 'Elige el creador que firma la cotización.');

  let companyId = input.companyId ?? null;
  const dealId = input.dealId ?? null;
  if (dealId) {
    if (!isUuid(dealId)) throw new CotizarError('DealNotFound', 'Ese negocio no existe en este espacio de trabajo.');
    const { rows } = await tx.query<{ company_id: string }>('SELECT company_id FROM deal WHERE id = $1', [dealId]);
    if (!rows[0]) throw new CotizarError('DealNotFound', 'Ese negocio no existe en este espacio de trabajo.');
    companyId = rows[0].company_id;
  }
  if (!companyId || !isUuid(companyId)) {
    throw new CotizarError('CompanyNotFound', 'Elige la marca a la que le cotizas.');
  }
  if (input.items.length === 0) {
    throw new CotizarError('QuoteSinItems', 'Una cotización necesita al menos un entregable.');
  }

  const { rows: ws } = await tx.query<{ currency: string }>('SELECT currency FROM workspace WHERE id = $1', [tx.workspaceId]);
  const moneda = (ws[0]?.currency ?? 'COP').toUpperCase();
  const taxRate = tasaParaGuardar(input.taxRate);
  const totales = calcularTotalesCotizacion({
    items: input.items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice })),
    discount: input.discount,
    taxRate: taxRate ?? undefined,
    currency: moneda,
  });

  const number = await nextQuoteNumber(tx);

  const { rows: creadas } = await tx.query<{ id: string }>(
    `INSERT INTO quote (workspace_id, deal_id, company_id, creator_id, media_kit_id, number, slug, currency,
                        subtotal, discount, tax, total, tax_rate, agreed_metrics, report_cuts_hours,
                        usage_rights_days, exclusivity_days, exclusivity_scope, payment_terms_days,
                        campaign_starts_on, campaign_ends_on, valid_until, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13::text[], $14::int[],
             $15, $16, $17, $18, $19::date, $20::date, $21::date, 'draft')
     RETURNING id`,
    [
      dealId, companyId, input.creatorId, input.mediaKitId ?? null, number, nuevoSlug(),
      moneda,
      totales.subtotal, totales.discount, totales.tax, totales.total, taxRate,
      input.agreedMetrics ?? [], input.reportCutsHours ?? [24, 168, 720],
      input.usageRightsDays ?? null, input.exclusivityDays ?? null, input.exclusivityScope ?? null,
      input.paymentTermsDays ?? 30,
      input.campaignStartsOn ?? null, input.campaignEndsOn ?? null, input.validUntil ?? null,
    ],
  );
  const id = creadas[0]?.id;
  if (!id) throw new CotizarError('QuoteInsertError', 'No se pudo crear la cotización.');

  await insertItems(tx, id, input.items, totales.lineTotals);
  const quote = await getQuote(tx, id);
  if (!quote) throw new CotizarError('QuoteInsertError', 'No se pudo leer la cotización recién creada.');
  return quote;
}

async function insertItems(tx: WorkspaceTx, quoteId: string, items: readonly QuoteItemInput[], lineTotals: readonly Decimal[]): Promise<void> {
  for (const [i, item] of items.entries()) {
    await tx.query(
      `INSERT INTO quote_item (quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [quoteId, item.deliverable, item.platformId, item.description, item.quantity, item.unitPrice, lineTotals[i], i],
    );
  }
}

export interface UpdateQuoteInput extends Omit<CreateQuoteInput, 'creatorId' | 'dealId' | 'companyId'> {
  items: QuoteItemInput[];
}

/**
 * Reescribe un borrador entero: ítems y lo acordado. Una enviada ya no
 * se toca. Corregir un precio no quema otro número COT-AAAA-NNN.
 */
export async function updateQuoteDraft(tx: WorkspaceTx, id: string, input: UpdateQuoteInput): Promise<QuoteDetail> {
  const actual = await getQuote(tx, id);
  if (!actual) throw new QuoteNotFound();
  if (actual.status !== 'draft') throw new QuoteNotEditable(actual.status);
  if (input.items.length === 0) throw new CotizarError('QuoteSinItems', 'Una cotización necesita al menos un entregable.');

  const taxRate = tasaParaGuardar(input.taxRate);
  const totales = calcularTotalesCotizacion({
    items: input.items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice })),
    discount: input.discount,
    taxRate: taxRate ?? undefined,
    currency: actual.currency,
  });

  await tx.query(
    `UPDATE quote
        SET subtotal = $2, discount = $3, tax = $4, total = $5, tax_rate = $6,
            agreed_metrics = $7::text[], report_cuts_hours = $8::int[],
            usage_rights_days = $9, exclusivity_days = $10, exclusivity_scope = $11,
            payment_terms_days = $12, campaign_starts_on = $13::date, campaign_ends_on = $14::date,
            valid_until = $15::date
      WHERE id = $1 AND status = 'draft'`,
    [
      id, totales.subtotal, totales.discount, totales.tax, totales.total, taxRate,
      input.agreedMetrics ?? actual.agreedMetrics, input.reportCutsHours ?? actual.reportCutsHours,
      input.usageRightsDays ?? null, input.exclusivityDays ?? null, input.exclusivityScope ?? null,
      input.paymentTermsDays ?? actual.paymentTermsDays,
      input.campaignStartsOn ?? null, input.campaignEndsOn ?? null, input.validUntil ?? null,
    ],
  );
  await tx.query('DELETE FROM quote_item WHERE quote_id = $1', [id]);
  await insertItems(tx, id, input.items, totales.lineTotals);

  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  return quote;
}

/**
 * Borra un borrador. Una cotización enviada ya es un documento que la
 * marca tiene: esa no se borra, se rechaza o vence. Si el borrador era
 * el último número del año, el siguiente lo reutiliza.
 */
export async function deleteQuoteDraft(tx: WorkspaceTx, id: string): Promise<void> {
  const actual = await getQuote(tx, id);
  if (!actual) throw new QuoteNotFound();
  if (actual.status !== 'draft') throw new QuoteNotDraft(actual.status);
  await tx.query("DELETE FROM quote WHERE id = $1 AND status = 'draft'", [id]);
}

/**
 * Lo que la marca verá en el enlace, congelado al enviarlo. Editar la
 * cotización después no cambia un documento ya entregado, y la página
 * pública no necesita leer quote_item, company ni creator_profile en
 * vivo (una política menos por tabla; ver 0022).
 */
export interface QuotePublicSnapshot {
  version: 1;
  number: string;
  currency: string;
  locale: string;
  timezone: string;
  company: { name: string };
  creator: { displayName: string; handle: string | null };
  items: { description: string; platformId: PlatformId | null; quantity: number; unitPrice: Decimal; total: Decimal }[];
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  /** Fracción. Opcional: los snapshots anteriores a 0023 no la traen. */
  taxRate?: string | null;
  total: Decimal;
  acordado: {
    metrics: string[];
    cutsHours: number[];
    usageRightsDays: number | null;
    exclusivityDays: number | null;
    exclusivityScope: string | null;
    paymentTermsDays: number;
    campaignStartsOn: string | null;
    campaignEndsOn: string | null;
  };
  /** Enlace al media kit que la acompaña, si lo hay. */
  mediaKitSlug: string | null;
}

async function buildQuoteSnapshot(tx: WorkspaceTx, quote: QuoteDetail): Promise<QuotePublicSnapshot> {
  const { rows: creador } = await tx.query<{ display_name: string; handle: string | null }>(
    'SELECT display_name, handle FROM creator_profile WHERE id = $1',
    [quote.creatorId],
  );
  const { rows: kit } = await tx.query<{ slug: string }>(
    'SELECT k.slug FROM quote q JOIN media_kit k ON k.id = q.media_kit_id WHERE q.id = $1',
    [quote.id],
  );
  const { rows: ws } = await tx.query<{ locale: string; timezone: string }>(
    'SELECT locale, timezone FROM workspace WHERE id = $1',
    [tx.workspaceId],
  );
  return {
    version: 1,
    number: quote.number,
    currency: quote.currency,
    locale: ws[0]?.locale ?? 'es-CO',
    timezone: ws[0]?.timezone ?? 'UTC',
    company: { name: quote.companyName },
    creator: { displayName: creador[0]?.display_name ?? '', handle: creador[0]?.handle ?? null },
    items: quote.items.map((i) => ({
      description: i.description,
      platformId: i.platformId,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      total: i.total,
    })),
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax,
    taxRate: quote.taxRate,
    total: quote.total,
    acordado: {
      metrics: quote.agreedMetrics,
      cutsHours: quote.reportCutsHours,
      usageRightsDays: quote.usageRightsDays,
      exclusivityDays: quote.exclusivityDays,
      exclusivityScope: quote.exclusivityScope,
      paymentTermsDays: quote.paymentTermsDays,
      campaignStartsOn: quote.campaignStartsOn,
      campaignEndsOn: quote.campaignEndsOn,
    },
    mediaKitSlug: kit[0]?.slug ?? null,
  };
}

/**
 * La cotización tal como la ve (o la verá) la marca, para la vista
 * previa del panel. NO pasa por public_quote(): el creador mirando su
 * propio documento no es una visita, ni la marca como vista.
 *
 * Enviada: el snapshot congelado, que es lo que la marca tiene. Borrador:
 * el snapshot que se congelaría si se enviara ahora, para revisarlo
 * antes de «Enviar».
 */
export async function getQuotePreview(tx: WorkspaceTx, id: string): Promise<PublicQuoteView | null> {
  const quote = await getQuote(tx, id);
  if (!quote) return null;
  let snapshot: QuotePublicSnapshot;
  if (quote.status === 'draft') {
    snapshot = await buildQuoteSnapshot(tx, quote);
  } else {
    const { rows } = await tx.query<{ public_snapshot: QuotePublicSnapshot | null }>(
      'SELECT public_snapshot FROM quote WHERE id = $1',
      [id],
    );
    snapshot = rows[0]?.public_snapshot ?? (await buildQuoteSnapshot(tx, quote));
  }
  return {
    ...snapshot,
    slug: quote.slug,
    status: quote.status,
    validUntil: quote.validUntil,
    sentAt: quote.sentAt,
    viewedAt: quote.viewedAt,
    acceptedAt: quote.acceptedAt,
    acceptedByName: quote.acceptedByName,
    rejectedAt: quote.rejectedAt,
    expiredAt: quote.expiredAt,
  };
}

/**
 * Enviar. En el MVP no hay correo: enviar es congelar el documento,
 * dejarlo en 'sent' y entregar el enlace para pegarlo donde ya se está
 * hablando con la marca.
 *
 * Efecto en Ventas: el deal pasa a «Propuesta enviada» con su fila de
 * historial y su actividad, como lo haría el CRM a mano.
 */
export async function sendQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail> {
  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'draft') throw new QuoteTransitionError(quote.status, 'sent');
  if (quote.items.length === 0) throw new CotizarError('QuoteSinItems', 'Una cotización sin entregables no se puede enviar.');

  const snapshot = await buildQuoteSnapshot(tx, quote);
  await tx.query(
    `UPDATE quote SET status = 'sent', sent_at = coalesce(sent_at, now()), public_snapshot = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(snapshot)],
  );

  if (quote.dealId) await moverDealAPropuesta(tx, quote.dealId, quote.number);

  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}

async function moverDealAPropuesta(tx: WorkspaceTx, dealId: string, quoteNumber: string): Promise<void> {
  const { rows } = await tx.query<{ stage_id: string; is_won: boolean; is_lost: boolean; position: number }>(
    `SELECT d.stage_id, s.is_won, s.is_lost, s.position
       FROM deal d JOIN pipeline_stage s ON s.id = d.stage_id
      WHERE d.id = $1`,
    [dealId],
  );
  const deal = rows[0];
  if (!deal) return;
  // Un deal ganado o perdido no retrocede a «Propuesta enviada», y uno
  // que ya está más adelante (negociación) tampoco.
  const { rows: propuesta } = await tx.query<{ position: number }>(
    "SELECT position FROM pipeline_stage WHERE id = 'propuesta'",
  );
  const posPropuesta = propuesta[0]?.position ?? 4;
  if (deal.is_won || deal.is_lost || deal.position >= posPropuesta) {
    await registrarActividad(tx, dealId, 'proposal_sent', `Cotización ${quoteNumber} enviada`);
    return;
  }

  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_at, days_in_stage)
     SELECT $1, $2, 'propuesta', now(),
            CASE WHEN max(changed_at) IS NULL THEN NULL
                 ELSE round((extract(epoch FROM (now() - max(changed_at))) / 86400)::numeric, 2) END
       FROM deal_stage_history WHERE deal_id = $1`,
    [dealId, deal.stage_id],
  );
  await tx.query("UPDATE deal SET stage_id = 'propuesta', last_contact_at = now() WHERE id = $1", [dealId]);
  await registrarActividad(tx, dealId, 'proposal_sent', `Cotización ${quoteNumber} enviada`);
}

async function registrarActividad(
  tx: WorkspaceTx,
  dealId: string,
  kind: 'proposal_sent' | 'stage_change',
  subject: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, kind, subject, occurred_at, metadata)
     SELECT current_workspace_id(), d.company_id, d.id, $2, $3, now(), $4::jsonb
       FROM deal d WHERE d.id = $1`,
    [dealId, kind, subject, JSON.stringify(metadata)],
  );
}

/**
 * Aceptar desde el panel (la marca dijo que sí por otro canal). Hace lo
 * mismo que la función pública `public_quote_accept` de 0023: deja la
 * cotización en 'accepted' y el deal en «Ganado» con su historial.
 */
export async function acceptQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail> {
  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'sent' && quote.status !== 'viewed') throw new QuoteTransitionError(quote.status, 'accepted');

  await tx.query("UPDATE quote SET status = 'accepted', accepted_at = coalesce(accepted_at, now()) WHERE id = $1", [id]);
  if (quote.dealId) {
    await ganarDeal(tx, quote.dealId);
    await registrarActividad(tx, quote.dealId, 'stage_change', `Cotización ${quote.number} aceptada`, { quoteId: quote.id });
  }

  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}

export async function rejectQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail> {
  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'sent' && quote.status !== 'viewed') throw new QuoteTransitionError(quote.status, 'rejected');
  await tx.query("UPDATE quote SET status = 'rejected', rejected_at = coalesce(rejected_at, now()) WHERE id = $1", [id]);
  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}

async function ganarDeal(tx: WorkspaceTx, dealId: string): Promise<void> {
  const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [dealId]);
  const deal = rows[0];
  if (!deal || deal.stage_id === 'ganado') return;
  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_at, days_in_stage)
     SELECT $1, $2, 'ganado', now(),
            CASE WHEN max(changed_at) IS NULL THEN NULL
                 ELSE round((extract(epoch FROM (now() - max(changed_at))) / 86400)::numeric, 2) END
       FROM deal_stage_history WHERE deal_id = $1`,
    [dealId, deal.stage_id],
  );
  await tx.query(
    "UPDATE deal SET stage_id = 'ganado', probability = NULL, won_at = coalesce(won_at, now()), lost_at = NULL WHERE id = $1",
    [dealId],
  );
}

// ---------------------------------------------------------------------
// Las tres funciones públicas (sin sesión ni workspace)
// ---------------------------------------------------------------------

export type PublicMediaKitResult =
  | { status: 'not_found' }
  | { status: 'expired'; expiresAt: string }
  | { status: 'locked'; lockedUntil: string }
  | { status: 'password_required'; algo: string; salt: string }
  | { status: 'password_invalid'; algo: string; salt: string; attemptsLeft: number }
  | { status: 'ok'; slug: string; snapshot: MediaKitSnapshot; viewCount: number; createdAt: string };

/** Qué cuenta como visita. La vista previa del panel y los robots que desenrollan enlaces, no. */
export interface PublicReadOptions {
  /** false: leer sin sumar visita ni marcar la cotización como vista. Por defecto, true. */
  count?: boolean;
}

/**
 * Abre un media kit por su enlace. `password` es la que escribió la
 * visita: se deriva AQUÍ con la sal que devuelve la base, para que la
 * contraseña en claro no salga de este proceso.
 */
export async function readPublicMediaKit(
  tx: BaseTx,
  slug: string,
  password?: string | null,
  opts: PublicReadOptions = {},
): Promise<PublicMediaKitResult> {
  const count = opts.count ?? true;
  const primera = await llamarPublicMediaKit(tx, slug, null, count);
  if (primera.status !== 'password_required' || !password) return primera;
  const hash = await hashSharePassword(password, primera.salt);
  return llamarPublicMediaKit(tx, slug, hash, count);
}

async function llamarPublicMediaKit(tx: BaseTx, slug: string, hash: string | null, count: boolean): Promise<PublicMediaKitResult> {
  const { rows } = await tx.query<{ r: PublicMediaKitResult }>('SELECT public_media_kit($1, $2, $3) AS r', [slug, hash, count]);
  return rows[0]?.r ?? { status: 'not_found' };
}

export interface PublicQuoteView extends QuotePublicSnapshot {
  slug: string;
  status: QuoteStatus;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  acceptedByName?: string | null;
  rejectedAt?: string | null;
  expiredAt?: string | null;
}

export type PublicQuoteResult = { status: 'not_found' } | { status: 'ok'; quote: PublicQuoteView };

/** Abre una cotización por su enlace. Con `count` (por defecto), la marca queda registrada como vista. */
export async function readPublicQuote(tx: BaseTx, slug: string, opts: PublicReadOptions = {}): Promise<PublicQuoteResult> {
  const { rows } = await tx.query<{ r: PublicQuoteResult }>('SELECT public_quote($1, $2) AS r', [slug, opts.count ?? true]);
  return rows[0]?.r ?? { status: 'not_found' };
}

/** Quién acepta: la firma mínima que piden Bonsai y HoneyBook. */
export interface FirmaAceptacion {
  name: string;
  email: string;
}

export type PublicQuoteAcceptResult =
  | { status: 'not_found' }
  | { status: 'invalid_signer' }
  | { status: 'not_acceptable'; quoteStatus: QuoteStatus }
  | {
      status: 'ok';
      quoteId: string;
      quoteNumber: string;
      dealId: string | null;
      /**
       * El workspace de la cotización, leído por la función de la base.
       * Solo lo usa el servidor para abrir la transacción que crea la
       * campaña (COT-4); nunca viaja a la página pública.
       */
      workspaceId: string;
      acceptedAt: string;
    };

/**
 * «Aceptar cotización» desde el enlace público. Deja la cotización
 * aceptada (con nombre y correo de quien acepta) y el deal en «Ganado»
 * en una sola transacción. La campaña la crea después
 * `completePublicAcceptance` con el workspace que devuelve.
 */
export async function acceptPublicQuote(tx: BaseTx, slug: string, firma: FirmaAceptacion): Promise<PublicQuoteAcceptResult> {
  const { rows } = await tx.query<{ r: PublicQuoteAcceptResult }>(
    'SELECT public_quote_accept($1, $2, $3) AS r',
    [slug, firma.name, firma.email],
  );
  return rows[0]?.r ?? { status: 'not_found' };
}

// ---------------------------------------------------------------------
// COT-4 · El cruce con Campañas
// ---------------------------------------------------------------------

export interface CampanaDeCotizacion {
  campaignId: string;
  campaignName: string;
  /** false si la campaña ya existía: se devuelve esa, sin tocarla. */
  created: boolean;
}

/**
 * Crea la campaña de una cotización aceptada llamando a
 * `createCampaignFromQuote()` (CAM-2, queries/campanas.ts). Es la
 * dependencia D5 del backlog y el único punto donde Cotizar escribe en
 * la cadena de Campañas — indirectamente: esta función no inserta en
 * `campaign`, llama a la de Nicolás.
 *
 * Las fechas salen de lo acordado en la cotización
 * (campaign_starts_on / campaign_ends_on), que es lo que se pactó antes
 * de publicar; se pueden sustituir al llamar. Sin ninguna de las dos,
 * pide que se pacten en vez de inventarlas.
 *
 * Es idempotente porque CAM-2 lo es: llamarla dos veces devuelve la
 * misma campaña con created: false.
 */
export async function createCampaignForQuote(
  tx: WorkspaceTx,
  quoteId: string,
  fechas: { startsOn?: string; endsOn?: string } = {},
): Promise<CampanaDeCotizacion> {
  const quote = await getQuote(tx, quoteId);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'accepted') {
    throw new CotizarError('QuoteNotAccepted', `Solo una cotización aceptada crea campaña; esta está en «${quote.status}».`);
  }
  const startsOn = fechas.startsOn ?? quote.campaignStartsOn;
  const endsOn = fechas.endsOn ?? quote.campaignEndsOn;
  if (!startsOn || !endsOn) {
    throw new CotizarError(
      'FechasDeCampanaFaltan',
      'Falta la ventana de la campaña. Acuérdala en la cotización (inicio y fin) antes de crearla.',
    );
  }
  const { campaign, created } = await createCampaignFromQuote(tx, { quoteId: quote.id, startsOn, endsOn });
  return { campaignId: campaign.id, campaignName: campaign.name, created };
}

/** Lo que dejó una aceptación en Campañas: la campaña, o por qué quedó pendiente. */
export interface ResultadoCampana {
  campaign: CampanaDeCotizacion | null;
  /** El código del error si no se pudo crear (p. ej. 'FechasDeCampanaFaltan'); null si se creó. */
  pendingReason: string | null;
}

/**
 * Intenta crear la campaña DENTRO de la transacción de quien llama, sin
 * arriesgar lo demás: si CAM-2 la rechaza (faltan fechas, un conflicto),
 * se deshace solo su parte con un SAVEPOINT y la aceptación sigue en
 * pie. La cotización queda entonces con «Campaña: pendiente» y el
 * creador la termina desde el detalle.
 */
async function intentarCampana(tx: WorkspaceTx, quoteId: string): Promise<ResultadoCampana> {
  await tx.query('SAVEPOINT cotizar_campana');
  try {
    const campaign = await createCampaignForQuote(tx, quoteId);
    await tx.query('RELEASE SAVEPOINT cotizar_campana');
    return { campaign, pendingReason: null };
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT cotizar_campana');
    const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : 'CampaignError';
    return { campaign: null, pendingReason: code };
  }
}

/**
 * COT-4 desde el panel: aceptar y crear la campaña en UNA transacción.
 * Es lo que dice el criterio del backlog —«aceptar deja una campaña en
 * planned que Nicolás ve sin tocar nada»— sin un segundo clic.
 */
export async function acceptQuoteAndCreateCampaign(
  tx: WorkspaceTx,
  id: string,
): Promise<{ quote: QuoteDetail } & ResultadoCampana> {
  await acceptQuote(tx, id);
  const campana = await intentarCampana(tx, id);
  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  return { quote, ...campana };
}

/**
 * COT-4 desde el enlace: lo que queda después de `acceptPublicQuote`,
 * ya con el workspace de la cotización fijado por el cliente de base
 * (lib/db de la web lo abre con el workspaceId que devolvió la función
 * pública, nunca con uno que venga del navegador).
 *
 * Deja la actividad en el negocio, el aviso para el creador y la
 * campaña de CAM-2. Todo en la misma transacción; si la campaña no se
 * puede crear, el aviso lo dice y el detalle ofrece terminarla.
 */
export async function completePublicAcceptance(tx: WorkspaceTx, quoteId: string): Promise<ResultadoCampana> {
  const quote = await getQuote(tx, quoteId);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'accepted') {
    throw new CotizarError('QuoteNotAccepted', `Solo una cotización aceptada crea campaña; esta está en «${quote.status}».`);
  }
  const firma = quote.acceptedByName
    ? `${quote.acceptedByName}${quote.acceptedByEmail ? ` <${quote.acceptedByEmail}>` : ''}`
    : null;
  if (quote.dealId) {
    await registrarActividad(
      tx, quote.dealId, 'stage_change',
      `Cotización ${quote.number} aceptada${firma ? ` por ${firma}` : ''} desde el enlace`,
      { quoteId: quote.id, acceptedByName: quote.acceptedByName, acceptedByEmail: quote.acceptedByEmail },
    );
  }
  const campana = await intentarCampana(tx, quoteId);
  await tx.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     VALUES (current_workspace_id(), 'quote_accepted', 'success', $1, $2, 'quote', $3, $4)`,
    [
      `${quote.companyName} aceptó la cotización ${quote.number}`,
      campana.campaign
        ? `Aceptada${firma ? ` por ${firma}` : ''}. La campaña «${campana.campaign.campaignName}» ya está planeada.`
        : `Aceptada${firma ? ` por ${firma}` : ''}. La campaña quedó pendiente: termínala desde la cotización.`,
      quote.id,
      `/cotizar/cotizaciones/${quote.id}`,
    ],
  );
  return campana;
}

/** Los pasos del cálculo guardados en un ítem del tarifario, si los tiene. */
export function pasosDe(item: RateCardItem): PasoCalculo[] {
  const pasos = (item.adjustments as { pasos?: PasoCalculo[] }).pasos;
  return Array.isArray(pasos) ? pasos : [];
}
